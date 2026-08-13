//! Android default-device audio backend using miniaudio's `OpenSL ES`
//! implementation.

use std::{
	panic::{AssertUnwindSafe, catch_unwind},
	sync::{
		Arc, Mutex,
		atomic::{AtomicBool, Ordering},
		mpsc,
	},
	thread::{self, JoinHandle, ThreadId},
	time::Duration,
};

use maudio::{
	audio::{performance::PerformanceProfile, sample_rate::SampleRate},
	backend::Backend,
	device::{
		Device, DeviceOps,
		device_builder::{DeviceBuilder, DeviceBuilderOps},
		device_state::DeviceState,
	},
};

use super::{CaptureSink, DeviceConfig, PlaybackFill};
use crate::VoiceResult;

const AUDIO_CHANNELS: u32 = 1;
static AUDIO_BACKENDS: [Backend; 1] = [Backend::Opensl];
const WORKER_POLL: Duration = Duration::from_millis(20);
const STOPPED_GRACE_POLLS: usize = 5;

/// Serializes callback delivery with external stop and identifies the active
/// callback thread so callback-initiated teardown can be deferred.
struct CallbackGate {
	delivery_enabled: AtomicBool,
	stopped:          AtomicBool,
	callback_failed:  AtomicBool,
	callback:         Mutex<()>,
	active_callback:  Mutex<Option<ThreadId>>,
}

impl CallbackGate {
	const fn new() -> Self {
		Self {
			delivery_enabled: AtomicBool::new(true),
			stopped:          AtomicBool::new(false),
			callback_failed:  AtomicBool::new(false),
			callback:         Mutex::new(()),
			active_callback:  Mutex::new(None),
		}
	}

	fn disarm(&self) {
		self.delivery_enabled.store(false, Ordering::Release);
		self.stopped.store(true, Ordering::Release);
	}

	fn current_thread_is_callback(&self) -> bool {
		self
			.active_callback
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner())
			.as_ref()
			.is_some_and(|thread_id| *thread_id == thread::current().id())
	}

	fn wait_for_external_callback(&self) {
		let callback = self
			.callback
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		drop(callback);
	}
}

/// Marks the current thread as delivering user callback code until dropped.
struct CallbackActivity<'a> {
	gate: &'a CallbackGate,
}

impl<'a> CallbackActivity<'a> {
	fn enter(gate: &'a CallbackGate) -> Self {
		*gate
			.active_callback
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(thread::current().id());
		Self { gate }
	}
}

impl Drop for CallbackActivity<'_> {
	fn drop(&mut self) {
		*self
			.gate
			.active_callback
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
	}
}

fn sample_rate(config: DeviceConfig) -> VoiceResult<SampleRate> {
	SampleRate::try_from(config.sample_rate)
		.map_err(|error| format!("Unsupported audio sample rate {}: {error}", config.sample_rate))
}

/// Stops an owned miniaudio device without invoking lifecycle functions from a
/// callback thread. A short wait handles miniaudio's transient stopping state.
fn stop_device(device: &mut Device<f32>, failure: &'static str) -> VoiceResult<()> {
	for _ in 0..STOPPED_GRACE_POLLS {
		match device.get_state() {
			Ok(DeviceState::Uninitialized | DeviceState::Stopped) => return Ok(()),
			Ok(DeviceState::Started) => {
				return device
					.device_stop()
					.map_err(|error| format!("{failure}: {error}"));
			},
			Ok(DeviceState::Starting | DeviceState::Stopping) => thread::sleep(WORKER_POLL),
			Err(error) => return Err(format!("{failure}: {error}")),
		}
	}

	Err(format!("{failure}: Android audio device remained in a stopping state"))
}

/// Completes worker-owned teardown and drops the callback state with the
/// miniaudio device. `reason` is retained so unexpected worker termination is
/// returned by the next external stop.
fn finish_worker(
	mut device: Device<f32>,
	gate: &CallbackGate,
	failure: &'static str,
	callback_failure: &'static str,
	reason: Option<String>,
) -> VoiceResult<()> {
	gate.disarm();
	gate.wait_for_external_callback();
	let reason = reason.or_else(|| {
		(device.data_callback_panicked() || gate.callback_failed.load(Ordering::Acquire))
			.then(|| callback_failure.to_owned())
	});
	let stop_result = stop_device(&mut device, failure);
	// Device's drop releases the maudio callback state (including FillGuard).
	drop(device);

	if let Some(reason) = reason {
		match stop_result {
			Ok(()) => Err(reason),
			Err(error) => Err(format!("{reason}; {error}")),
		}
	} else {
		stop_result
	}
}

fn run_worker(
	device: Device<f32>,
	gate: Arc<CallbackGate>,
	stopped: mpsc::Receiver<()>,
	stop_failure: &'static str,
	unexpected_failure: &'static str,
	callback_failure: &'static str,
) -> VoiceResult<()> {
	let mut stopped_polls = 0;

	loop {
		if device.data_callback_panicked() || gate.callback_failed.load(Ordering::Acquire) {
			return finish_worker(
				device,
				&gate,
				stop_failure,
				callback_failure,
				Some(callback_failure.to_owned()),
			);
		}
		if gate.stopped.load(Ordering::Acquire) {
			return finish_worker(device, &gate, stop_failure, callback_failure, None);
		}

		let state = match device.get_state() {
			Ok(state) => state,
			Err(error) => {
				let reason = format!("{unexpected_failure}: failed to query device state: {error}");
				return finish_worker(device, &gate, stop_failure, callback_failure, Some(reason));
			},
		};
		match state {
			DeviceState::Started => stopped_polls = 0,
			DeviceState::Starting
			| DeviceState::Stopping
			| DeviceState::Stopped
			| DeviceState::Uninitialized => {
				stopped_polls += 1;
				if stopped_polls >= STOPPED_GRACE_POLLS {
					if gate.stopped.load(Ordering::Acquire) {
						return finish_worker(device, &gate, stop_failure, callback_failure, None);
					}
					return finish_worker(
						device,
						&gate,
						stop_failure,
						callback_failure,
						Some(unexpected_failure.to_owned()),
					);
				}
			},
		}

		match stopped.recv_timeout(WORKER_POLL) {
			Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => {
				return finish_worker(device, &gate, stop_failure, callback_failure, None);
			},
			Err(mpsc::RecvTimeoutError::Timeout) => {},
		}
	}
}

/// Owns the maudio device on a helper thread. That permits callback-thread
/// stop/drop to release the caller immediately while `device_stop`/uninit waits
/// for the callback from outside the real-time thread.
struct RunningDevice {
	stop:   Option<mpsc::Sender<()>>,
	worker: Option<JoinHandle<VoiceResult<()>>>,
	gate:   Arc<CallbackGate>,
}

impl RunningDevice {
	fn start(
		device: Device<f32>,
		gate: Arc<CallbackGate>,
		stop_failure: &'static str,
		unexpected_failure: &'static str,
		callback_failure: &'static str,
	) -> VoiceResult<Self> {
		let (stop, stopped) = mpsc::channel();
		let worker_gate = Arc::clone(&gate);
		let worker = match thread::Builder::new()
			.name("pi-voice-android-audio".to_owned())
			.spawn(move || {
				run_worker(
					device,
					worker_gate,
					stopped,
					stop_failure,
					unexpected_failure,
					callback_failure,
				)
			}) {
			Ok(worker) => worker,
			Err(error) => {
				gate.disarm();
				gate.wait_for_external_callback();
				return Err(format!("Failed to start Android audio lifecycle worker: {error}"));
			},
		};
		Ok(Self { stop: Some(stop), worker: Some(worker), gate })
	}

	fn signal_stop(&mut self) {
		// Disconnecting also wakes the worker if no explicit message can be
		// enqueued, and makes repeated stop requests harmless.
		drop(self.stop.take());
	}

	fn stop(&mut self, failure: &'static str) -> VoiceResult<()> {
		self.gate.delivery_enabled.store(false, Ordering::Release);
		self.gate.stopped.store(true, Ordering::Release);
		self.signal_stop();
		if self.gate.current_thread_is_callback() {
			// The worker owns device_stop and final Device drop. Do not join it
			// from the callback thread; a later external stop can still join and
			// observe teardown completion.
			return Ok(());
		}

		self.gate.wait_for_external_callback();
		let Some(worker) = self.worker.take() else {
			return Ok(());
		};
		match worker.join() {
			Ok(result) => result,
			Err(_) => Err(format!("{failure}: Android audio lifecycle worker panicked")),
		}
	}
}

/// Running Android default-speaker device.
pub struct PlaybackDevice {
	running: RunningDevice,
}

impl PlaybackDevice {
	/// Opens the default speaker through `OpenSL ES` with low-latency mono f32
	/// output at the requested sample rate and period.
	pub fn start(config: DeviceConfig, mut fill: PlaybackFill) -> VoiceResult<Self> {
		let sample_rate = sample_rate(config)?;
		let gate = Arc::new(CallbackGate::new());
		let callback_gate = Arc::clone(&gate);
		let mut builder = DeviceBuilder::playback().f32();
		builder
			.sample_rate(sample_rate)
			.playback_channels(AUDIO_CHANNELS)
			.period_size_millis(config.period_ms)
			.performance_profile(PerformanceProfile::LowLatency)
			.pre_silenced_output(true)
			.backends(AUDIO_BACKENDS.as_slice());
		let mut device = builder
			.with_callback(move |_device, output| {
				let _callback = callback_gate
					.callback
					.lock()
					.unwrap_or_else(|poisoned| poisoned.into_inner());
				if !callback_gate.delivery_enabled.load(Ordering::Acquire) {
					return;
				}
				let _activity = CallbackActivity::enter(&callback_gate);
				if catch_unwind(AssertUnwindSafe(|| fill(output))).is_err() {
					callback_gate.callback_failed.store(true, Ordering::Release);
					callback_gate
						.delivery_enabled
						.store(false, Ordering::Release);
					output.fill(0.0);
				}
			})
			.map_err(|error| format!("Failed to open the default speaker: {error}"))?;
		if let Err(error) = device.device_start() {
			gate.disarm();
			gate.wait_for_external_callback();
			return Err(format!("Failed to start speaker playback: {error}"));
		}

		Ok(Self {
			running: RunningDevice::start(
				device,
				gate,
				"Failed to stop speaker playback",
				"Android speaker playback stopped unexpectedly",
				"Android speaker playback callback panicked",
			)?,
		})
	}

	/// Stops the device and prevents further callback delivery.
	pub fn stop(&mut self) -> VoiceResult<()> {
		self.running.stop("Failed to stop speaker playback")
	}
}

impl Drop for PlaybackDevice {
	fn drop(&mut self) {
		let _ = self.stop();
	}
}

/// Running Android default-microphone device.
pub struct CaptureDevice {
	running: RunningDevice,
}

impl CaptureDevice {
	/// Opens the default microphone through `OpenSL ES` with low-latency mono
	/// f32 input at the requested sample rate and period.
	pub fn start(config: DeviceConfig, mut sink: CaptureSink) -> VoiceResult<Self> {
		let sample_rate = sample_rate(config)?;
		let gate = Arc::new(CallbackGate::new());
		let callback_gate = Arc::clone(&gate);
		let mut builder = DeviceBuilder::capture().f32();
		builder
			.sample_rate(sample_rate)
			.capture_channels(AUDIO_CHANNELS)
			.period_size_millis(config.period_ms)
			.performance_profile(PerformanceProfile::LowLatency)
			.backends(AUDIO_BACKENDS.as_slice());
		let mut device = builder
			.with_callback(move |_device, samples| {
				let _callback = callback_gate
					.callback
					.lock()
					.unwrap_or_else(|poisoned| poisoned.into_inner());
				if !callback_gate.delivery_enabled.load(Ordering::Acquire) || samples.is_empty() {
					return;
				}
				let _activity = CallbackActivity::enter(&callback_gate);
				if catch_unwind(AssertUnwindSafe(|| sink(samples))).is_err() {
					callback_gate.callback_failed.store(true, Ordering::Release);
					callback_gate
						.delivery_enabled
						.store(false, Ordering::Release);
				}
			})
			.map_err(|error| format!("Failed to open the default microphone: {error}"))?;
		if let Err(error) = device.device_start() {
			gate.disarm();
			gate.wait_for_external_callback();
			return Err(format!("Failed to start microphone capture: {error}"));
		}

		Ok(Self {
			running: RunningDevice::start(
				device,
				gate,
				"Failed to stop microphone capture",
				"Android microphone capture stopped unexpectedly",
				"Android microphone capture callback panicked",
			)?,
		})
	}

	/// Stops the device and prevents further callback delivery.
	pub fn stop(&mut self) -> VoiceResult<()> {
		self.running.stop("Failed to stop microphone capture")
	}
}

impl Drop for CaptureDevice {
	fn drop(&mut self) {
		let _ = self.stop();
	}
}
