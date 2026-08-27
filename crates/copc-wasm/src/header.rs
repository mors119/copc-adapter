use serde::Serialize;

use crate::binary::{ensure_range, read_f64, read_u16, read_u32, read_u64, safe_u64};
use crate::error::{ParseError, error};
use crate::vlr::{VlrVisit, for_each_vlr};

const LAS_HEADER_SIZE: usize = 375;
const COPC_INFO_SIZE: usize = 160;

#[derive(Debug, Serialize)]
pub(crate) struct CopcHeaderResult {
    pub(crate) version_major: u8,
    pub(crate) version_minor: u8,
    pub(crate) point_data_record_format: u8,
    pub(crate) point_data_record_length: u16,
    pub(crate) point_count: u64,
    pub(crate) scale: [f64; 3],
    pub(crate) offset: [f64; 3],
    pub(crate) bounds: [f64; 6],
    pub(crate) cube: [f64; 6],
    pub(crate) spacing: f64,
    pub(crate) root_hierarchy_page_offset: u64,
    pub(crate) root_hierarchy_page_length: u64,
    pub(crate) wkt: Option<String>,
}

struct CopcInfo {
    center: [f64; 3],
    half_size: f64,
    spacing: f64,
    root_offset: u64,
    root_length: u64,
}

pub(crate) fn parse_header(bytes: &[u8]) -> Result<CopcHeaderResult, ParseError> {
    ensure_range(bytes, 0, LAS_HEADER_SIZE, "LAS 1.4 header")?;
    if &bytes[0..4] != b"LASF" {
        return Err(error("invalid-header", "LAS signature is not LASF"));
    }

    let version_major = bytes[24];
    let version_minor = bytes[25];
    if version_major != 1 || version_minor != 4 {
        return Err(error(
            "unsupported-value",
            format!("COPC requires LAS 1.4, found LAS {version_major}.{version_minor}"),
        ));
    }

    let header_size = read_u16(bytes, 94, "header size")? as usize;
    if header_size < LAS_HEADER_SIZE {
        return Err(error(
            "invalid-header",
            format!("LAS 1.4 header size {header_size} is smaller than {LAS_HEADER_SIZE}"),
        ));
    }
    ensure_range(bytes, 0, header_size, "declared LAS header")?;

    let point_data_offset = read_u32(bytes, 96, "point data offset")? as usize;
    let number_of_vlrs = read_u32(bytes, 100, "number of VLRs")? as usize;
    if point_data_offset < header_size {
        return Err(error(
            "invalid-header",
            "point data offset precedes the LAS header",
        ));
    }
    ensure_range(bytes, 0, point_data_offset, "LAS VLR area")?;

    let scale = [
        read_f64(bytes, 131, "X scale")?,
        read_f64(bytes, 139, "Y scale")?,
        read_f64(bytes, 147, "Z scale")?,
    ];
    let offset = [
        read_f64(bytes, 155, "X offset")?,
        read_f64(bytes, 163, "Y offset")?,
        read_f64(bytes, 171, "Z offset")?,
    ];
    let bounds = [
        read_f64(bytes, 187, "minimum X")?,
        read_f64(bytes, 203, "minimum Y")?,
        read_f64(bytes, 219, "minimum Z")?,
        read_f64(bytes, 179, "maximum X")?,
        read_f64(bytes, 195, "maximum Y")?,
        read_f64(bytes, 211, "maximum Z")?,
    ];
    let point_count = safe_u64(read_u64(bytes, 247, "extended point count")?, "point count")?;

    let point_data_record_format = bytes[104] & 0x0f;
    let point_data_record_length = read_u16(bytes, 105, "point data record length")?;
    let mut copc_info: Option<CopcInfo> = None;
    let mut wkt: Option<String> = None;

    for_each_vlr(
        bytes,
        header_size,
        point_data_offset,
        number_of_vlrs,
        "VLR payload offset overflows the input",
        |record_user_id, record_id, payload| {
            if record_user_id == "copc" && record_id == 1 {
                if payload.len() != COPC_INFO_SIZE {
                    return Err(error(
                        "malformed-copc-info",
                        format!(
                            "COPC info VLR has {} bytes; expected {COPC_INFO_SIZE}",
                            payload.len()
                        ),
                    ));
                }
                copc_info = Some(CopcInfo {
                    center: [
                        read_f64(payload, 0, "COPC center X")?,
                        read_f64(payload, 8, "COPC center Y")?,
                        read_f64(payload, 16, "COPC center Z")?,
                    ],
                    half_size: read_f64(payload, 24, "COPC half-size")?,
                    spacing: read_f64(payload, 32, "COPC spacing")?,
                    root_offset: read_u64(payload, 40, "root hierarchy page offset")?,
                    root_length: read_u64(payload, 48, "root hierarchy page length")?,
                });
            }

            if record_user_id == "LASF_Projection" && record_id == 2112 {
                let end = payload
                    .iter()
                    .position(|byte| *byte == 0)
                    .unwrap_or(payload.len());
                let value = String::from_utf8(payload[..end].to_vec())
                    .map_err(|_| error("malformed-wkt", "WKT VLR is not valid UTF-8"))?;
                if !value.is_empty() {
                    wkt = Some(value);
                }
            }

            Ok(VlrVisit::Continue)
        },
    )?;

    let copc_info = copc_info.ok_or_else(|| {
        error(
            "missing-copc-info",
            "COPC info VLR (user ID copc, record ID 1) was not found",
        )
    })?;
    let root_offset = safe_u64(copc_info.root_offset, "root hierarchy page offset")?;
    let root_length = safe_u64(copc_info.root_length, "root hierarchy page length")?;
    if root_length == 0 {
        return Err(error(
            "invalid-value",
            "root hierarchy page length must be positive",
        ));
    }
    let root_end = root_offset
        .checked_add(root_length)
        .ok_or_else(|| error("overflow", "root hierarchy page range overflows"))?;
    safe_u64(root_end, "root hierarchy page end")?;
    let center = copc_info.center;
    let half_size = copc_info.half_size;
    let spacing = copc_info.spacing;
    if half_size <= 0.0 || spacing <= 0.0 {
        return Err(error(
            "invalid-value",
            "COPC half-size and spacing must be positive",
        ));
    }

    let cube = [
        center[0] - half_size,
        center[1] - half_size,
        center[2] - half_size,
        center[0] + half_size,
        center[1] + half_size,
        center[2] + half_size,
    ];
    if cube.iter().any(|value| !value.is_finite()) {
        return Err(error("invalid-value", "COPC cube bounds are not finite"));
    }

    Ok(CopcHeaderResult {
        version_major,
        version_minor,
        point_data_record_format,
        point_data_record_length,
        point_count,
        scale,
        offset,
        bounds,
        cube,
        spacing,
        root_hierarchy_page_offset: root_offset,
        root_hierarchy_page_length: root_length,
        wkt,
    })
}

#[cfg(test)]
mod parser_tests {
    use super::parse_header;
    use crate::hierarchy::parse_root_hierarchy;

    fn put_u16(bytes: &mut [u8], offset: usize, value: u16) {
        bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn put_i32(bytes: &mut [u8], offset: usize, value: i32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn put_i64(bytes: &mut [u8], offset: usize, value: i64) {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    fn put_f64(bytes: &mut [u8], offset: usize, value: f64) {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    fn fixture_header(copc_length: u16) -> Vec<u8> {
        let header_size = 375usize;
        let vlr_start = header_size;
        let point_data_offset = vlr_start + 54 + copc_length as usize;
        let mut bytes = vec![0; point_data_offset];
        bytes[0..4].copy_from_slice(b"LASF");
        bytes[24] = 1;
        bytes[25] = 4;
        put_u16(&mut bytes, 94, header_size as u16);
        put_u32(&mut bytes, 96, point_data_offset as u32);
        put_u32(&mut bytes, 100, 1);
        bytes[104] = 6;
        put_u16(&mut bytes, 105, 30);
        put_f64(&mut bytes, 131, 0.01);
        put_f64(&mut bytes, 139, 0.02);
        put_f64(&mut bytes, 147, 0.03);
        put_f64(&mut bytes, 155, 10.0);
        put_f64(&mut bytes, 163, 20.0);
        put_f64(&mut bytes, 171, 30.0);
        put_f64(&mut bytes, 179, 100.0);
        put_f64(&mut bytes, 187, 200.0);
        put_f64(&mut bytes, 195, 300.0);
        put_f64(&mut bytes, 203, 1.0);
        put_f64(&mut bytes, 211, 2.0);
        put_f64(&mut bytes, 219, 3.0);
        put_u64(&mut bytes, 247, 42);
        bytes[vlr_start + 2..vlr_start + 6].copy_from_slice(b"copc");
        put_u16(&mut bytes, vlr_start + 18, 1);
        put_u16(&mut bytes, vlr_start + 20, copc_length);
        if copc_length == 160 {
            let payload = vlr_start + 54;
            put_f64(&mut bytes, payload, 50.0);
            put_f64(&mut bytes, payload + 8, 60.0);
            put_f64(&mut bytes, payload + 16, 70.0);
            put_f64(&mut bytes, payload + 24, 10.0);
            put_f64(&mut bytes, payload + 32, 2.5);
            put_u64(&mut bytes, payload + 40, 999);
            put_u64(&mut bytes, payload + 48, 64);
        }
        bytes
    }

    fn put_u64(bytes: &mut [u8], offset: usize, value: u64) {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    #[test]
    fn parses_header_and_copc_info() {
        let result = parse_header(&fixture_header(160)).expect("fixture should parse");
        assert_eq!(result.point_count, 42);
        assert_eq!(result.root_hierarchy_page_offset, 999);
        assert_eq!(result.cube, [40.0, 50.0, 60.0, 60.0, 70.0, 80.0]);
    }

    #[test]
    fn rejects_missing_and_malformed_copc_info() {
        assert_eq!(parse_header(&[0; 374]).unwrap_err().code, "truncated");
        let missing = vec![0; 375];
        assert_eq!(parse_header(&missing).unwrap_err().code, "invalid-header");
        assert_eq!(
            parse_header(&fixture_header(8)).unwrap_err().code,
            "malformed-copc-info"
        );
    }

    #[test]
    fn separates_page_references_from_point_nodes() {
        let mut bytes = vec![0; 64];
        put_i32(&mut bytes, 0, 0);
        put_i64(&mut bytes, 16, 100);
        put_i32(&mut bytes, 24, 32);
        put_i32(&mut bytes, 28, 12);
        put_i32(&mut bytes, 32, 1);
        put_i32(&mut bytes, 36, 0);
        put_i32(&mut bytes, 40, 0);
        put_i64(&mut bytes, 48, 200);
        put_i32(&mut bytes, 56, 64);
        put_i32(&mut bytes, 60, -1);
        let result = parse_root_hierarchy(&bytes).expect("fixture should parse");
        assert_eq!(result.nodes.len(), 1);
        assert_eq!(result.pages.len(), 1);
    }

    #[test]
    fn rejects_unaligned_and_invalid_hierarchy_entries() {
        assert_eq!(
            parse_root_hierarchy(&[0; 31]).unwrap_err().code,
            "invalid-hierarchy"
        );
        let mut bytes = vec![0; 32];
        put_i32(&mut bytes, 28, -2);
        assert_eq!(
            parse_root_hierarchy(&bytes).unwrap_err().code,
            "invalid-hierarchy"
        );
    }
}
