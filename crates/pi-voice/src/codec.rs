//! Opus codec backend selected per platform.
//!
//! Desktop builds retain the libopus-backed `opus` crate. Android uses the
//! pure-Rust Mousiki backend through `opus2`, avoiding a platform-specific C
//! build-script patch in the source-built Termux addon.

#[cfg(not(target_os = "android"))]
pub(crate) use opus::{Application, Channels, Decoder, Encoder};
#[cfg(target_os = "android")]
pub(crate) use opus2::{Application, Channels, Decoder, Encoder};

#[cfg(test)]
mod tests {
	use super::{Application, Channels, Decoder, Encoder};
	// Reference libopus 1.6.1: 20 ms, 16 kHz mono, VoIP mode, 440 Hz PCM.
	const LIBOPUS_REFERENCE_PACKET: [u8; 73] = [
		0x48, 0x82, 0xb4, 0xf2, 0xf3, 0xb1, 0x71, 0xbd, 0x00, 0x00, 0x01, 0x07, 0x49, 0x36, 0xec,
		0x80, 0x5a, 0x56, 0x30, 0x98, 0xa8, 0xea, 0x08, 0xcd, 0x0d, 0x5f, 0x21, 0x1a, 0x23, 0x67,
		0x65, 0xa4, 0x61, 0xf3, 0x12, 0x31, 0x21, 0xf1, 0xdd, 0x2e, 0x66, 0x2f, 0x93, 0x14, 0x2a,
		0xe2, 0xe2, 0x19, 0xc3, 0x10, 0x25, 0x1f, 0x87, 0x65, 0x09, 0x6e, 0x26, 0x48, 0x66, 0x07,
		0x8a, 0xe9, 0xfb, 0x92, 0xfc, 0xb9, 0x18, 0x1f, 0x13, 0xf5, 0x6b, 0x4d, 0x40,
	];

	fn assert_decodes_audible(packet: &[u8]) {
		let mut decoder = Decoder::new(48_000, Channels::Mono).expect("decoder initializes");
		let mut output = [0.0f32; 960];
		let decoded = decoder
			.decode_float(packet, &mut output, false)
			.expect("frame decodes");

		assert_eq!(decoded, output.len());
		assert!(output.iter().any(|sample| sample.abs() > 0.001));
	}

	#[test]
	fn live_mono_frame_round_trips_through_selected_codec() {
		let mut encoder =
			Encoder::new(16_000, Channels::Mono, Application::Voip).expect("encoder initializes");
		encoder
			.set_inband_fec(true)
			.expect("in-band FEC is supported");

		let input: [f32; 320] = std::array::from_fn(|index| {
			(f32::from(index as u16) * 440.0 * std::f32::consts::TAU / 16_000.0).sin() * 0.25
		});
		let mut packet = [0u8; 1_275];
		let encoded = encoder
			.encode_float(&input, &mut packet)
			.expect("frame encodes");

		assert_decodes_audible(&packet[..encoded]);
	}

	#[test]
	fn selected_codec_decodes_reference_libopus_packet() {
		assert_decodes_audible(&LIBOPUS_REFERENCE_PACKET);
	}
}
