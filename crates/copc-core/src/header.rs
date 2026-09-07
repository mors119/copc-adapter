use crate::binary::{ensure_range, read_f64, read_u16, read_u32, read_u64};
use crate::error::{CopcError, Result};
use crate::vlr::{VlrVisit, for_each_vlr};

const LAS_HEADER_SIZE: usize = 375;
const COPC_INFO_SIZE: usize = 160;

#[derive(Debug, Clone, PartialEq)]
pub struct CopcHeader {
    pub version_major: u8,
    pub version_minor: u8,
    pub point_data_record_format: u8,
    pub point_data_record_length: u16,
    pub point_count: u64,
    pub scale: [f64; 3],
    pub offset: [f64; 3],
    pub bounds: [f64; 6],
    pub cube: [f64; 6],
    pub spacing: f64,
    pub root_hierarchy_page_offset: u64,
    pub root_hierarchy_page_length: u64,
    pub wkt: Option<String>,
}

struct CopcInfo {
    center: [f64; 3],
    half_size: f64,
    spacing: f64,
    root_offset: u64,
    root_length: u64,
}

pub fn parse_header(bytes: &[u8]) -> Result<CopcHeader> {
    ensure_range(bytes, 0, LAS_HEADER_SIZE, "LAS 1.4 header")?;
    if &bytes[0..4] != b"LASF" {
        return Err(CopcError::new(
            "invalid-header",
            "LAS signature is not LASF",
        ));
    }

    let version_major = bytes[24];
    let version_minor = bytes[25];
    if version_major != 1 || version_minor != 4 {
        return Err(CopcError::new(
            "unsupported-value",
            format!("COPC requires LAS 1.4, found LAS {version_major}.{version_minor}"),
        ));
    }

    let header_size = read_u16(bytes, 94, "header size")? as usize;
    if header_size < LAS_HEADER_SIZE {
        return Err(CopcError::new(
            "invalid-header",
            format!("LAS 1.4 header size {header_size} is smaller than {LAS_HEADER_SIZE}"),
        ));
    }
    ensure_range(bytes, 0, header_size, "declared LAS header")?;

    let point_data_offset = read_u32(bytes, 96, "point data offset")? as usize;
    let number_of_vlrs = read_u32(bytes, 100, "number of VLRs")? as usize;
    if point_data_offset < header_size {
        return Err(CopcError::new(
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
    let point_count = read_u64(bytes, 247, "extended point count")?;

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
                    return Err(CopcError::new(
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
                    .map_err(|_| CopcError::new("malformed-wkt", "WKT VLR is not valid UTF-8"))?;
                if !value.is_empty() {
                    wkt = Some(value);
                }
            }

            Ok(VlrVisit::Continue)
        },
    )?;

    let copc_info = copc_info.ok_or_else(|| {
        CopcError::new(
            "missing-copc-info",
            "COPC info VLR (user ID copc, record ID 1) was not found",
        )
    })?;
    let root_offset = copc_info.root_offset;
    let root_length = copc_info.root_length;
    if root_length == 0 {
        return Err(CopcError::new(
            "invalid-value",
            "root hierarchy page length must be positive",
        ));
    }
    root_offset
        .checked_add(root_length)
        .ok_or_else(|| CopcError::new("overflow", "root hierarchy page range overflows"))?;
    let center = copc_info.center;
    let half_size = copc_info.half_size;
    let spacing = copc_info.spacing;
    if half_size <= 0.0 || spacing <= 0.0 {
        return Err(CopcError::new(
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
        return Err(CopcError::new(
            "invalid-value",
            "COPC cube bounds are not finite",
        ));
    }

    Ok(CopcHeader {
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
mod tests {
    use super::parse_header;

    fn put_u16(bytes: &mut [u8], offset: usize, value: u16) {
        bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn put_f64(bytes: &mut [u8], offset: usize, value: f64) {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u64(bytes: &mut [u8], offset: usize, value: u64) {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    fn fixture_header(copc_length: u16) -> Vec<u8> {
        let header_size = 375usize;
        let copc_length = usize::from(copc_length);
        let point_data_offset = header_size + 54 + copc_length;
        let mut bytes = vec![0; point_data_offset];
        bytes[0..4].copy_from_slice(b"LASF");
        bytes[24] = 1;
        bytes[25] = 4;
        put_u16(&mut bytes, 94, header_size as u16);
        put_u32(&mut bytes, 96, point_data_offset as u32);
        put_u32(&mut bytes, 100, 1);
        bytes[104] = 0x86;
        put_u16(&mut bytes, 105, 30);
        put_f64(&mut bytes, 131, 0.01);
        put_f64(&mut bytes, 139, 0.02);
        put_f64(&mut bytes, 147, 0.03);
        put_f64(&mut bytes, 155, 10.0);
        put_f64(&mut bytes, 163, 20.0);
        put_f64(&mut bytes, 171, 30.0);
        put_f64(&mut bytes, 179, 100.0);
        put_f64(&mut bytes, 187, 1.0);
        put_f64(&mut bytes, 195, 200.0);
        put_f64(&mut bytes, 203, 2.0);
        put_f64(&mut bytes, 211, 300.0);
        put_f64(&mut bytes, 219, 3.0);
        put_u64(&mut bytes, 247, 42);

        let vlr = header_size;
        bytes[vlr + 2..vlr + 6].copy_from_slice(b"copc");
        put_u16(&mut bytes, vlr + 18, 1);
        put_u16(&mut bytes, vlr + 20, copc_length as u16);
        if copc_length == 160 {
            let payload = vlr + 54;
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

    #[test]
    fn parses_header_and_copc_info() {
        let result = parse_header(&fixture_header(160)).expect("fixture should parse");
        assert_eq!(result.point_count, 42);
        assert_eq!(result.root_hierarchy_page_offset, 999);
        assert_eq!(result.cube, [40.0, 50.0, 60.0, 60.0, 70.0, 80.0]);
    }

    #[test]
    fn rejects_truncated_and_invalid_copc_headers() {
        assert_eq!(parse_header(&[0; 374]).unwrap_err().code(), "truncated");
        let missing = vec![0; 375];
        assert_eq!(parse_header(&missing).unwrap_err().code(), "invalid-header");
        assert_eq!(
            parse_header(&fixture_header(8)).unwrap_err().code(),
            "malformed-copc-info"
        );

        let mut overflow = fixture_header(160);
        put_u64(&mut overflow, 375 + 54 + 40, u64::MAX);
        assert_eq!(parse_header(&overflow).unwrap_err().code(), "overflow");
    }

    #[test]
    fn preserves_u64_domain_offsets_for_native_consumers() {
        let mut bytes = fixture_header(160);
        put_u64(&mut bytes, 375 + 54 + 40, u64::from(u32::MAX) + 1);
        put_u64(&mut bytes, 375 + 54 + 48, 64);
        let result = parse_header(&bytes).expect("native core accepts a valid u64 offset");
        assert_eq!(result.root_hierarchy_page_offset, u64::from(u32::MAX) + 1);
    }
}
