use laz::LazVlr;
use laz::las::selective::DecompressionSelection;
use laz::record::{LayeredPointRecordDecompressor, RecordDecompressor};
use serde::Serialize;
use std::io::Cursor;

use crate::binary::{read_u16, read_u32};
use crate::error::{ParseError, error};
use crate::header::{CopcHeaderResult, parse_header};
use crate::memory::{mutable_f64_slice, mutable_u8_slice, mutable_u16_slice};
use crate::vlr::{VlrVisit, for_each_vlr};

const FIELD_INTENSITY: u32 = 1 << 0;
const FIELD_CLASSIFICATION: u32 = 1 << 1;
const FIELD_RGB: u32 = 1 << 2;
const KNOWN_FIELD_MASK: u32 = FIELD_INTENSITY | FIELD_CLASSIFICATION | FIELD_RGB;
const MAX_DECODE_POINTS: usize = 5_000_000;
const MAX_NODE_CHUNK_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub(crate) struct DecodeResult {
    point_count: usize,
    intensity: bool,
    classification: bool,
    rgb: bool,
}

pub(crate) fn parse_laz_vlr(bytes: &[u8], header: &CopcHeaderResult) -> Result<LazVlr, ParseError> {
    let header_size = read_u16(bytes, 94, "header size")? as usize;
    let point_data_offset = read_u32(bytes, 96, "point data offset")? as usize;
    let number_of_vlrs = read_u32(bytes, 100, "number of VLRs")? as usize;
    if bytes.get(104).is_none_or(|format| format & 0x80 == 0) {
        return Err(error(
            "unsupported-value",
            "COPC node data is not marked as compressed LAZ",
        ));
    }

    let expected_record_length = match header.point_data_record_format {
        6 => 30,
        7 => 36,
        8 => 38,
        format => {
            return Err(error(
                "unsupported-point-format",
                format!("LAS point format {format} is outside the initial COPC decoder scope"),
            ));
        }
    };
    if usize::from(header.point_data_record_length) != expected_record_length {
        return Err(error(
            "unsupported-point-format",
            format!(
                "LAS point format {} has {} bytes per record; extra bytes are not supported",
                header.point_data_record_format, header.point_data_record_length
            ),
        ));
    }

    let mut laz_vlr = None;
    for_each_vlr(
        bytes,
        header_size,
        point_data_offset,
        number_of_vlrs,
        "LAZ VLR payload offset overflows the input",
        |user_id, record_id, payload| {
            if user_id == LazVlr::USER_ID && record_id == LazVlr::RECORD_ID {
                laz_vlr = Some(
                    LazVlr::from_buffer(payload)
                        .map_err(|value| error("invalid-laz-vlr", value.to_string()))?,
                );
                return Ok(VlrVisit::Stop);
            }
            Ok(VlrVisit::Continue)
        },
    )?;

    if let Some(laz_vlr) = laz_vlr {
        return Ok(laz_vlr);
    }

    Err(error(
        "missing-laz-vlr",
        "LASZIP VLR is required to decode a COPC node",
    ))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn decode_copc_node_impl(
    metadata: &[u8],
    chunk: &[u8],
    point_count: usize,
    requested_fields: u32,
    coordinates_ptr: *mut f64,
    intensity_ptr: *mut u16,
    classification_ptr: *mut u8,
    red_ptr: *mut u16,
    green_ptr: *mut u16,
    blue_ptr: *mut u16,
) -> Result<DecodeResult, ParseError> {
    if requested_fields & !KNOWN_FIELD_MASK != 0 {
        return Err(error(
            "unsupported-value",
            "unknown COPC point field selection bits",
        ));
    }
    if point_count == 0 {
        return Err(error(
            "invalid-value",
            "COPC node point count must be positive",
        ));
    }
    if point_count > MAX_DECODE_POINTS {
        return Err(error(
            "unsupported-value",
            format!("COPC node has more than the {MAX_DECODE_POINTS}-point safety limit"),
        ));
    }
    if chunk.len() > MAX_NODE_CHUNK_BYTES {
        return Err(error(
            "unsupported-value",
            format!("COPC node chunk exceeds the {MAX_NODE_CHUNK_BYTES}-byte safety limit"),
        ));
    }
    let header = parse_header(metadata)?;
    let laz_vlr = parse_laz_vlr(metadata, &header)?;
    let record_length = usize::try_from(laz_vlr.items_size())
        .map_err(|_| error("overflow", "LAZ record length does not fit in this target"))?;
    if record_length != usize::from(header.point_data_record_length) {
        return Err(error(
            "invalid-laz-vlr",
            format!(
                "LASZIP record length {record_length} does not match LAS record length {}",
                header.point_data_record_length
            ),
        ));
    }

    let compressed_count_offset = record_length;
    let compressed_count =
        read_u32(chunk, compressed_count_offset, "COPC chunk point count")? as usize;
    if compressed_count != point_count {
        return Err(error(
            "chunk-length-mismatch",
            format!("hierarchy says {point_count} points but chunk says {compressed_count}"),
        ));
    }
    let raw_length = point_count
        .checked_mul(record_length)
        .ok_or_else(|| error("overflow", "decompressed point buffer size overflows"))?;
    if chunk.len() < record_length + 4 {
        return Err(error(
            "truncated",
            "COPC node chunk is shorter than its first point and count",
        ));
    }

    let has_intensity = requested_fields & FIELD_INTENSITY != 0;
    let has_classification = requested_fields & FIELD_CLASSIFICATION != 0;
    let has_rgb = requested_fields & FIELD_RGB != 0 && header.point_data_record_format >= 7;
    let mut selection = DecompressionSelection::xy_returns_channel().decompress_z();
    if has_intensity {
        selection = selection.decompress_intensity();
    }
    if has_classification {
        selection = selection.decompress_classification();
    }
    if has_rgb {
        selection = selection.decompress_rgb();
    }

    let mut decompressor = LayeredPointRecordDecompressor::new(Cursor::new(chunk));
    decompressor
        .set_fields_from(laz_vlr.items())
        .map_err(|value| error("laz-decode", value.to_string()))?;
    decompressor.set_selection(selection);

    let mut raw = Vec::new();
    raw.try_reserve_exact(raw_length)
        .map_err(|_| error("allocation", "unable to allocate decompressed point buffer"))?;
    raw.resize(raw_length, 0);
    decompressor
        .decompress_many(&mut raw)
        .map_err(|value| error("laz-decode", value.to_string()))?;
    let consumed = usize::try_from(decompressor.get().position()).map_err(|_| {
        error(
            "overflow",
            "LAZ decoder position does not fit in this target",
        )
    })?;
    if consumed != chunk.len() {
        return Err(error(
            "chunk-length-mismatch",
            format!(
                "LAZ decoder consumed {consumed} bytes from a {0}-byte node chunk",
                chunk.len()
            ),
        ));
    }

    let coordinates = mutable_f64_slice(coordinates_ptr, point_count * 3)?;
    let mut intensity = if has_intensity {
        Some(mutable_u16_slice(intensity_ptr, point_count)?)
    } else {
        None
    };
    let mut classification = if has_classification {
        Some(mutable_u8_slice(classification_ptr, point_count)?)
    } else {
        None
    };
    let mut red = if has_rgb {
        Some(mutable_u16_slice(red_ptr, point_count)?)
    } else {
        None
    };
    let mut green = if has_rgb {
        Some(mutable_u16_slice(green_ptr, point_count)?)
    } else {
        None
    };
    let mut blue = if has_rgb {
        Some(mutable_u16_slice(blue_ptr, point_count)?)
    } else {
        None
    };

    for index in 0..point_count {
        let record = &raw[index * record_length..(index + 1) * record_length];
        let x = i32::from_le_bytes(record[0..4].try_into().unwrap()) as f64;
        let y = i32::from_le_bytes(record[4..8].try_into().unwrap()) as f64;
        let z = i32::from_le_bytes(record[8..12].try_into().unwrap()) as f64;
        coordinates[index * 3] = x * header.scale[0] + header.offset[0];
        coordinates[index * 3 + 1] = y * header.scale[1] + header.offset[1];
        coordinates[index * 3 + 2] = z * header.scale[2] + header.offset[2];
        if let Some(values) = intensity.as_deref_mut() {
            values[index] = u16::from_le_bytes(record[12..14].try_into().unwrap());
        }
        if let Some(values) = classification.as_deref_mut() {
            values[index] = record[16];
        }
        if has_rgb {
            if let Some(values) = red.as_deref_mut() {
                values[index] = u16::from_le_bytes(record[30..32].try_into().unwrap());
            }
            if let Some(values) = green.as_deref_mut() {
                values[index] = u16::from_le_bytes(record[32..34].try_into().unwrap());
            }
            if let Some(values) = blue.as_deref_mut() {
                values[index] = u16::from_le_bytes(record[34..36].try_into().unwrap());
            }
        }
    }

    Ok(DecodeResult {
        point_count,
        intensity: has_intensity,
        classification: has_classification,
        rgb: has_rgb,
    })
}

#[cfg(test)]
mod tests {
    use laz::LazVlr;

    use super::parse_laz_vlr;
    use crate::header::CopcHeaderResult;

    fn test_header() -> CopcHeaderResult {
        CopcHeaderResult {
            version_major: 1,
            version_minor: 4,
            point_data_record_format: 6,
            point_data_record_length: 30,
            point_count: 1,
            scale: [0.01; 3],
            offset: [0.0; 3],
            bounds: [0.0; 6],
            cube: [0.0; 6],
            spacing: 1.0,
            root_hierarchy_page_offset: 0,
            root_hierarchy_page_length: 1,
            wkt: None,
        }
    }

    fn metadata(user_id: &str, record_id: u16, payload_length: usize) -> Vec<u8> {
        let header_size = 375usize;
        let point_data_offset = header_size + 54 + payload_length;
        let mut bytes = vec![0; point_data_offset];
        bytes[94..96].copy_from_slice(&(header_size as u16).to_le_bytes());
        bytes[96..100].copy_from_slice(&(point_data_offset as u32).to_le_bytes());
        bytes[100..104].copy_from_slice(&1u32.to_le_bytes());
        bytes[104] = 0x86;
        bytes[105..107].copy_from_slice(&30u16.to_le_bytes());
        bytes[375 + 2..375 + 2 + user_id.len()].copy_from_slice(user_id.as_bytes());
        bytes[375 + 18..375 + 20].copy_from_slice(&record_id.to_le_bytes());
        bytes[375 + 20..375 + 22].copy_from_slice(&(payload_length as u16).to_le_bytes());
        bytes
    }

    #[test]
    fn rejects_missing_laszip_vlr() {
        let bytes = metadata("copc", 1, 0);
        let result = parse_laz_vlr(&bytes, &test_header()).unwrap_err();
        assert_eq!(result.code, "missing-laz-vlr");
        assert_eq!(
            result.message,
            "LASZIP VLR is required to decode a COPC node"
        );
    }

    #[test]
    fn rejects_malformed_laszip_vlr() {
        let bytes = metadata(LazVlr::USER_ID, LazVlr::RECORD_ID, 0);
        let result = parse_laz_vlr(&bytes, &test_header()).unwrap_err();
        assert_eq!(result.code, "invalid-laz-vlr");
    }
}
