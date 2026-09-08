use std::io::Cursor;

use laz::LazVlr;
use laz::las::selective::DecompressionSelection;
use laz::record::{LayeredPointRecordDecompressor, RecordDecompressor};

use crate::binary::{read_u16, read_u32};
use crate::error::{CopcError, Result};
use crate::header::{CopcHeader, parse_header};
use crate::vlr::{VlrVisit, for_each_vlr};

pub const FIELD_INTENSITY: u32 = 1 << 0;
pub const FIELD_CLASSIFICATION: u32 = 1 << 1;
pub const FIELD_RGB: u32 = 1 << 2;

const KNOWN_FIELD_MASK: u32 = FIELD_INTENSITY | FIELD_CLASSIFICATION | FIELD_RGB;
const MAX_DECODE_POINTS: usize = 5_000_000;
const MAX_NODE_CHUNK_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct DecodedCopcNode {
    pub point_count: usize,
    pub coordinates: Vec<f64>,
    pub intensity: Option<Vec<u16>>,
    pub classification: Option<Vec<u8>>,
    pub red: Option<Vec<u16>>,
    pub green: Option<Vec<u16>>,
    pub blue: Option<Vec<u16>>,
}

/// A validated decoder initialized from one dataset's LAS/LAZ metadata.
///
/// The header and LASZIP VLR are intentionally retained so node jobs do not
/// repeatedly parse the complete metadata buffer.
pub struct CopcNodeDecoder {
    header: CopcHeader,
    laz_vlr: LazVlr,
}

fn parse_laz_vlr(bytes: &[u8], header: &CopcHeader) -> Result<LazVlr> {
    let header_size = read_u16(bytes, 94, "header size")? as usize;
    let point_data_offset = read_u32(bytes, 96, "point data offset")? as usize;
    let number_of_vlrs = read_u32(bytes, 100, "number of VLRs")? as usize;
    if bytes.get(104).is_none_or(|format| format & 0x80 == 0) {
        return Err(CopcError::new(
            "unsupported-value",
            "COPC node data is not marked as compressed LAZ",
        ));
    }

    let expected_record_length = match header.point_data_record_format {
        6 => 30,
        7 => 36,
        8 => 38,
        format => {
            return Err(CopcError::new(
                "unsupported-point-format",
                format!("LAS point format {format} is outside the initial COPC decoder scope"),
            ));
        }
    };
    if usize::from(header.point_data_record_length) != expected_record_length {
        return Err(CopcError::new(
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
                        .map_err(|value| CopcError::new("invalid-laz-vlr", value.to_string()))?,
                );
                return Ok(VlrVisit::Stop);
            }
            Ok(VlrVisit::Continue)
        },
    )?;

    laz_vlr.ok_or_else(|| {
        CopcError::new(
            "missing-laz-vlr",
            "LASZIP VLR is required to decode a COPC node",
        )
    })
}

impl CopcNodeDecoder {
    pub fn from_metadata(metadata: &[u8]) -> Result<Self> {
        let header = parse_header(metadata)?;
        let laz_vlr = parse_laz_vlr(metadata, &header)?;
        let record_length = usize::try_from(laz_vlr.items_size()).map_err(|_| {
            CopcError::new("overflow", "LAZ record length does not fit in this target")
        })?;
        if record_length != usize::from(header.point_data_record_length) {
            return Err(CopcError::new(
                "invalid-laz-vlr",
                format!(
                    "LASZIP record length {record_length} does not match LAS record length {}",
                    header.point_data_record_length
                ),
            ));
        }

        Ok(Self { header, laz_vlr })
    }

    pub fn header(&self) -> &CopcHeader {
        &self.header
    }

    pub fn decode(
        &self,
        chunk: &[u8],
        point_count: usize,
        requested_fields: u32,
    ) -> Result<DecodedCopcNode> {
        if requested_fields & !KNOWN_FIELD_MASK != 0 {
            return Err(CopcError::new(
                "unsupported-value",
                "unknown COPC point field selection bits",
            ));
        }
        if point_count == 0 {
            return Err(CopcError::new(
                "invalid-value",
                "COPC node point count must be positive",
            ));
        }
        if point_count > MAX_DECODE_POINTS {
            return Err(CopcError::new(
                "unsupported-value",
                format!("COPC node has more than the {MAX_DECODE_POINTS}-point safety limit"),
            ));
        }
        if chunk.len() > MAX_NODE_CHUNK_BYTES {
            return Err(CopcError::new(
                "unsupported-value",
                format!("COPC node chunk exceeds the {MAX_NODE_CHUNK_BYTES}-byte safety limit"),
            ));
        }
        let header = &self.header;
        let laz_vlr = &self.laz_vlr;
        let record_length = usize::from(header.point_data_record_length);

        let compressed_count_offset = record_length;
        let compressed_count =
            read_u32(chunk, compressed_count_offset, "COPC chunk point count")? as usize;
        if compressed_count != point_count {
            return Err(CopcError::new(
                "chunk-length-mismatch",
                format!("hierarchy says {point_count} points but chunk says {compressed_count}"),
            ));
        }
        let raw_length = point_count.checked_mul(record_length).ok_or_else(|| {
            CopcError::new("overflow", "decompressed point buffer size overflows")
        })?;
        if chunk.len() < record_length + 4 {
            return Err(CopcError::new(
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
            .map_err(|value| CopcError::new("laz-decode", value.to_string()))?;
        decompressor.set_selection(selection);

        let mut raw = Vec::new();
        raw.try_reserve_exact(raw_length).map_err(|_| {
            CopcError::new("allocation", "unable to allocate decompressed point buffer")
        })?;
        raw.resize(raw_length, 0);
        decompressor
            .decompress_many(&mut raw)
            .map_err(|value| CopcError::new("laz-decode", value.to_string()))?;
        let consumed = usize::try_from(decompressor.get().position()).map_err(|_| {
            CopcError::new(
                "overflow",
                "LAZ decoder position does not fit in this target",
            )
        })?;
        if consumed != chunk.len() {
            return Err(CopcError::new(
                "chunk-length-mismatch",
                format!(
                    "LAZ decoder consumed {consumed} bytes from a {}-byte node chunk",
                    chunk.len()
                ),
            ));
        }

        let mut coordinates = vec![0.0; point_count * 3];
        let mut intensity = has_intensity.then(|| vec![0; point_count]);
        let mut classification = has_classification.then(|| vec![0; point_count]);
        let mut red = has_rgb.then(|| vec![0; point_count]);
        let mut green = has_rgb.then(|| vec![0; point_count]);
        let mut blue = has_rgb.then(|| vec![0; point_count]);

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

        Ok(DecodedCopcNode {
            point_count,
            coordinates,
            intensity,
            classification,
            red,
            green,
            blue,
        })
    }
}

pub fn decode_copc_node(
    metadata: &[u8],
    chunk: &[u8],
    point_count: usize,
    requested_fields: u32,
) -> Result<DecodedCopcNode> {
    CopcNodeDecoder::from_metadata(metadata)?.decode(chunk, point_count, requested_fields)
}

#[cfg(test)]
mod tests {
    use laz::record::{LayeredPointRecordCompressor, RecordCompressor};
    use laz::{LazVlr, LazVlrBuilder};

    use crate::CopcNodePreparer;

    use super::{FIELD_CLASSIFICATION, FIELD_INTENSITY, FIELD_RGB, decode_copc_node};

    fn put_u16(bytes: &mut [u8], offset: usize, value: u16) {
        bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn put_i32(bytes: &mut [u8], offset: usize, value: i32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u64(bytes: &mut [u8], offset: usize, value: u64) {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    fn put_f64(bytes: &mut [u8], offset: usize, value: f64) {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    fn put_vlr(
        bytes: &mut [u8],
        offset: usize,
        user_id: &str,
        record_id: u16,
        payload: &[u8],
    ) -> usize {
        bytes[offset + 2..offset + 2 + user_id.len()].copy_from_slice(user_id.as_bytes());
        put_u16(bytes, offset + 18, record_id);
        put_u16(bytes, offset + 20, payload.len() as u16);
        bytes[offset + 54..offset + 54 + payload.len()].copy_from_slice(payload);
        offset + 54 + payload.len()
    }

    fn compressed_fixture() -> (Vec<u8>, Vec<u8>) {
        let laz_vlr = LazVlrBuilder::default()
            .with_point_format(7, 0)
            .unwrap()
            .with_variable_chunk_size()
            .build();
        let mut laz_payload = Vec::new();
        laz_vlr.write_to(&mut laz_payload).unwrap();

        let header_size = 375;
        let wkt = br#"GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]"#;
        let point_data_offset = header_size + 54 + 160 + 54 + wkt.len() + 54 + laz_payload.len();
        let mut metadata = vec![0; point_data_offset];
        metadata[0..4].copy_from_slice(b"LASF");
        metadata[24] = 1;
        metadata[25] = 4;
        put_u16(&mut metadata, 94, header_size as u16);
        put_u32(&mut metadata, 96, point_data_offset as u32);
        put_u32(&mut metadata, 100, 3);
        metadata[104] = 7 | 0x80;
        put_u16(&mut metadata, 105, 36);
        put_u64(&mut metadata, 247, 2);
        put_f64(&mut metadata, 131, 0.01);
        put_f64(&mut metadata, 139, 0.02);
        put_f64(&mut metadata, 147, 0.03);
        put_f64(&mut metadata, 155, 10.0);
        put_f64(&mut metadata, 163, 20.0);
        put_f64(&mut metadata, 171, 30.0);
        put_f64(&mut metadata, 179, 100.0);
        put_f64(&mut metadata, 187, 1.0);
        put_f64(&mut metadata, 195, 200.0);
        put_f64(&mut metadata, 203, 2.0);
        put_f64(&mut metadata, 211, 300.0);
        put_f64(&mut metadata, 219, 3.0);

        let mut copc_payload = vec![0; 160];
        put_f64(&mut copc_payload, 0, 50.0);
        put_f64(&mut copc_payload, 8, 60.0);
        put_f64(&mut copc_payload, 16, 70.0);
        put_f64(&mut copc_payload, 24, 10.0);
        put_f64(&mut copc_payload, 32, 2.5);
        put_u64(&mut copc_payload, 40, point_data_offset as u64 + 32);
        put_u64(&mut copc_payload, 48, 64);
        let copc_end = put_vlr(&mut metadata, header_size, "copc", 1, &copc_payload);
        let wkt_end = put_vlr(&mut metadata, copc_end, "LASF_Projection", 2112, wkt);
        put_vlr(
            &mut metadata,
            wkt_end,
            LazVlr::USER_ID,
            LazVlr::RECORD_ID,
            &laz_payload,
        );

        let mut raw = vec![0; 72];
        for (index, (x, y, z, intensity, classification, rgb)) in [
            (100, 200, 300, 400, 5, [600, 700, 800]),
            (101, 201, 301, 401, 6, [601, 701, 801]),
        ]
        .into_iter()
        .enumerate()
        {
            let record = &mut raw[index * 36..(index + 1) * 36];
            put_i32(record, 0, x);
            put_i32(record, 4, y);
            put_i32(record, 8, z);
            put_u16(record, 12, intensity);
            record[16] = classification;
            put_u16(record, 30, rgb[0]);
            put_u16(record, 32, rgb[1]);
            put_u16(record, 34, rgb[2]);
        }
        let mut compressor = LayeredPointRecordCompressor::new(Vec::new());
        compressor.set_fields_from(laz_vlr.items()).unwrap();
        compressor.compress_many(&raw).unwrap();
        compressor.done().unwrap();
        (metadata, compressor.into_inner())
    }

    #[test]
    fn decodes_supported_point_format_and_requested_attributes_natively() {
        let (metadata, chunk) = compressed_fixture();
        let result = decode_copc_node(
            &metadata,
            &chunk,
            2,
            FIELD_INTENSITY | FIELD_CLASSIFICATION | FIELD_RGB,
        )
        .expect("compressed fixture should decode");
        assert_eq!(result.coordinates, [11.0, 24.0, 39.0, 11.01, 24.02, 39.03]);
        assert_eq!(result.intensity.as_deref(), Some(&[400, 401][..]));
        assert_eq!(result.classification.as_deref(), Some(&[5, 6][..]));
        assert_eq!(result.red.as_deref(), Some(&[600, 601][..]));
        assert_eq!(result.green.as_deref(), Some(&[700, 701][..]));
        assert_eq!(result.blue.as_deref(), Some(&[800, 801][..]));

        let selected = decode_copc_node(&metadata, &chunk, 2, FIELD_CLASSIFICATION)
            .expect("selective decode should succeed");
        assert_eq!(selected.classification.as_deref(), Some(&[5, 6][..]));
        assert!(selected.intensity.is_none());
        assert!(selected.red.is_none());
    }

    #[test]
    fn prepares_coordinates_and_statistics_in_one_dataset_scoped_path() {
        let (metadata, chunk) = compressed_fixture();
        let preparer = CopcNodePreparer::from_metadata(&metadata)
            .expect("fixture metadata should initialize the node preparer");
        let prepared = preparer
            .prepare_node(
                &chunk,
                2,
                FIELD_INTENSITY | FIELD_CLASSIFICATION | FIELD_RGB,
            )
            .expect("fixture node should be prepared");

        assert_eq!(prepared.point_count, 2);
        assert_eq!(prepared.source_coordinates[0..4], [11.0, 24.0, 39.0, 11.01]);
        assert!((prepared.source_coordinates[4] - 24.02).abs() < 1e-12);
        assert_eq!(prepared.source_coordinates[5], 39.03);
        for (geographic, source) in prepared
            .geographic_coordinates
            .iter()
            .zip(prepared.source_coordinates.iter())
        {
            assert!((geographic - source).abs() < 1e-12);
        }
        assert!(
            prepared
                .ecef_coordinates
                .iter()
                .all(|value| value.is_finite())
        );
        assert_eq!(prepared.statistics.elevation.as_ref().unwrap().min, 39.0);
        assert_eq!(prepared.statistics.elevation.as_ref().unwrap().max, 39.03);
        assert_eq!(prepared.statistics.intensity.as_ref().unwrap().min, 400.0);
        assert_eq!(prepared.statistics.intensity.as_ref().unwrap().max, 401.0);
        assert_eq!(prepared.statistics.rgb_max, Some(65535));
    }

    #[test]
    fn rejects_decode_limits_and_malformed_chunks() {
        let (metadata, chunk) = compressed_fixture();
        assert_eq!(
            decode_copc_node(&metadata, &chunk, 0, 0)
                .unwrap_err()
                .code(),
            "invalid-value"
        );
        assert_eq!(
            decode_copc_node(&metadata, &chunk, 5_000_001, 0)
                .unwrap_err()
                .code(),
            "unsupported-value"
        );
        assert_eq!(
            decode_copc_node(&metadata, &chunk, 2, 8)
                .unwrap_err()
                .code(),
            "unsupported-value"
        );

        let mut mismatched = chunk.clone();
        put_u32(&mut mismatched, 36, 1);
        assert_eq!(
            decode_copc_node(&metadata, &mismatched, 2, 0)
                .unwrap_err()
                .code(),
            "chunk-length-mismatch"
        );
    }
}
