use serde::Serialize;
use std::ffi::{CString, c_char};

const LAS_HEADER_SIZE: usize = 375;
const VLR_HEADER_SIZE: usize = 54;
const COPC_INFO_SIZE: usize = 160;
const HIERARCHY_ENTRY_SIZE: usize = 32;
const MAX_HIERARCHY_PAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Serialize)]
struct ParseError {
    code: &'static str,
    message: String,
}

#[derive(Serialize)]
#[serde(untagged, bound = "T: Serialize")]
enum ParseResponse<T> {
    Success { ok: bool, value: T },
    Failure { ok: bool, error: ParseError },
}

impl<T> ParseResponse<T> {
    fn success(value: T) -> Self {
        Self::Success { ok: true, value }
    }

    fn failure(error: ParseError) -> Self {
        Self::Failure { ok: false, error }
    }
}

fn error(code: &'static str, message: impl Into<String>) -> ParseError {
    ParseError {
        code,
        message: message.into(),
    }
}

#[derive(Debug, Serialize)]
struct CopcHeaderResult {
    version_major: u8,
    version_minor: u8,
    point_data_record_format: u8,
    point_data_record_length: u16,
    point_count: u64,
    scale: [f64; 3],
    offset: [f64; 3],
    bounds: [f64; 6],
    cube: [f64; 6],
    spacing: f64,
    root_hierarchy_page_offset: u64,
    root_hierarchy_page_length: u64,
    wkt: Option<String>,
}

#[derive(Debug, Serialize)]
struct RootHierarchyNode {
    level: i32,
    x: i32,
    y: i32,
    z: i32,
    point_data_offset: u64,
    point_data_length: u32,
    point_count: u32,
}

#[derive(Debug, Serialize)]
struct RootHierarchyPage {
    level: i32,
    x: i32,
    y: i32,
    z: i32,
    page_offset: u64,
    page_length: u32,
}

#[derive(Debug, Serialize)]
struct RootHierarchyResult {
    entry_count: usize,
    nodes: Vec<RootHierarchyNode>,
    pages: Vec<RootHierarchyPage>,
}

struct CopcInfo {
    center: [f64; 3],
    half_size: f64,
    spacing: f64,
    root_offset: u64,
    root_length: u64,
}

fn ensure_range(bytes: &[u8], start: usize, length: usize, what: &str) -> Result<(), ParseError> {
    let end = start.checked_add(length).ok_or_else(|| {
        error(
            "overflow",
            format!("{what} range overflows the addressable input"),
        )
    })?;

    if end > bytes.len() {
        return Err(error(
            "truncated",
            format!(
                "{what} requires bytes through {end}, input has {}",
                bytes.len()
            ),
        ));
    }

    Ok(())
}

fn read_u16(bytes: &[u8], offset: usize, what: &str) -> Result<u16, ParseError> {
    ensure_range(bytes, offset, 2, what)?;
    Ok(u16::from_le_bytes([bytes[offset], bytes[offset + 1]]))
}

fn read_u32(bytes: &[u8], offset: usize, what: &str) -> Result<u32, ParseError> {
    ensure_range(bytes, offset, 4, what)?;
    Ok(u32::from_le_bytes(
        bytes[offset..offset + 4].try_into().unwrap(),
    ))
}

fn read_i32(bytes: &[u8], offset: usize, what: &str) -> Result<i32, ParseError> {
    ensure_range(bytes, offset, 4, what)?;
    Ok(i32::from_le_bytes(
        bytes[offset..offset + 4].try_into().unwrap(),
    ))
}

fn read_u64(bytes: &[u8], offset: usize, what: &str) -> Result<u64, ParseError> {
    ensure_range(bytes, offset, 8, what)?;
    Ok(u64::from_le_bytes(
        bytes[offset..offset + 8].try_into().unwrap(),
    ))
}

fn read_i64(bytes: &[u8], offset: usize, what: &str) -> Result<i64, ParseError> {
    ensure_range(bytes, offset, 8, what)?;
    Ok(i64::from_le_bytes(
        bytes[offset..offset + 8].try_into().unwrap(),
    ))
}

fn read_f64(bytes: &[u8], offset: usize, what: &str) -> Result<f64, ParseError> {
    ensure_range(bytes, offset, 8, what)?;
    let value = f64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap());
    if !value.is_finite() {
        return Err(error("invalid-value", format!("{what} is not finite")));
    }
    Ok(value)
}

fn safe_u64(value: u64, what: &str) -> Result<u64, ParseError> {
    if value > MAX_SAFE_INTEGER {
        return Err(error(
            "unsupported-value",
            format!("{what} exceeds JavaScript's safe integer range"),
        ));
    }
    Ok(value)
}

fn las_string(bytes: &[u8]) -> String {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).trim().to_owned()
}

fn parse_header(bytes: &[u8]) -> Result<CopcHeaderResult, ParseError> {
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
    let mut position = header_size;
    let mut copc_info: Option<CopcInfo> = None;
    let mut wkt: Option<String> = None;

    for _ in 0..number_of_vlrs {
        ensure_range(bytes, position, VLR_HEADER_SIZE, "VLR header")?;
        let record_user_id = las_string(&bytes[position + 2..position + 18]);
        let record_id = read_u16(bytes, position + 18, "VLR record ID")?;
        let record_length = read_u16(bytes, position + 20, "VLR record length")? as usize;
        let payload_start = position
            .checked_add(VLR_HEADER_SIZE)
            .ok_or_else(|| error("overflow", "VLR payload offset overflows the input"))?;
        ensure_range(bytes, payload_start, record_length, "VLR payload")?;
        let payload_end = payload_start + record_length;
        if payload_end > point_data_offset {
            return Err(error("invalid-header", "VLR payload overlaps point data"));
        }
        let payload = &bytes[payload_start..payload_end];

        if record_user_id == "copc" && record_id == 1 {
            if record_length != COPC_INFO_SIZE {
                return Err(error(
                    "malformed-copc-info",
                    format!("COPC info VLR has {record_length} bytes; expected {COPC_INFO_SIZE}"),
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

        position = payload_end;
    }

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

fn validate_key(level: i32, x: i32, y: i32, z: i32) -> Result<(), ParseError> {
    if !(0..=31).contains(&level) || x < 0 || y < 0 || z < 0 {
        return Err(error(
            "invalid-hierarchy",
            "hierarchy voxel key is outside supported bounds",
        ));
    }
    let maximum = if level == 31 {
        i64::from(i32::MAX)
    } else {
        (1_i64 << level) - 1
    };
    if i64::from(x) > maximum || i64::from(y) > maximum || i64::from(z) > maximum {
        return Err(error(
            "invalid-hierarchy",
            "hierarchy voxel coordinate exceeds its level",
        ));
    }
    Ok(())
}

fn parse_root_hierarchy(bytes: &[u8]) -> Result<RootHierarchyResult, ParseError> {
    if bytes.len() > MAX_HIERARCHY_PAGE_BYTES {
        return Err(error(
            "unsupported-value",
            format!("root hierarchy page exceeds {MAX_HIERARCHY_PAGE_BYTES} bytes"),
        ));
    }
    if bytes.is_empty() || bytes.len() % HIERARCHY_ENTRY_SIZE != 0 {
        return Err(error(
            "invalid-hierarchy",
            format!(
                "root hierarchy length {} is not aligned to {HIERARCHY_ENTRY_SIZE}",
                bytes.len()
            ),
        ));
    }

    let entry_count = bytes.len() / HIERARCHY_ENTRY_SIZE;
    let mut nodes = Vec::with_capacity(entry_count);
    let mut pages = Vec::new();
    for index in 0..entry_count {
        let start = index * HIERARCHY_ENTRY_SIZE;
        let level = read_i32(bytes, start, "hierarchy level")?;
        let x = read_i32(bytes, start + 4, "hierarchy X")?;
        let y = read_i32(bytes, start + 8, "hierarchy Y")?;
        let z = read_i32(bytes, start + 12, "hierarchy Z")?;
        validate_key(level, x, y, z)?;
        let offset = read_i64(bytes, start + 16, "hierarchy byte offset")?;
        let byte_size = read_i32(bytes, start + 24, "hierarchy byte size")?;
        let point_count = read_i32(bytes, start + 28, "hierarchy point count")?;
        if offset < 0 || byte_size < 0 {
            return Err(error(
                "invalid-hierarchy",
                "hierarchy offsets and lengths cannot be negative",
            ));
        }
        let offset = safe_u64(offset as u64, "hierarchy byte offset")?;
        let end = offset
            .checked_add(byte_size as u32 as u64)
            .ok_or_else(|| error("overflow", "hierarchy byte range overflows"))?;
        safe_u64(end, "hierarchy byte range end")?;
        if point_count == -1 {
            if byte_size == 0 {
                return Err(error(
                    "invalid-hierarchy",
                    "hierarchy page length must be positive",
                ));
            }
            pages.push(RootHierarchyPage {
                level,
                x,
                y,
                z,
                page_offset: offset,
                page_length: byte_size as u32,
            });
        } else if point_count >= 0 {
            nodes.push(RootHierarchyNode {
                level,
                x,
                y,
                z,
                point_data_offset: offset,
                point_data_length: byte_size as u32,
                point_count: point_count as u32,
            });
        } else {
            return Err(error(
                "invalid-hierarchy",
                "unsupported negative hierarchy point count",
            ));
        }
    }

    Ok(RootHierarchyResult {
        entry_count,
        nodes,
        pages,
    })
}

fn input_slice<'a>(ptr: *const u8, length: usize) -> Result<&'a [u8], ParseError> {
    if length == 0 {
        return Ok(&[]);
    }
    if ptr.is_null() {
        return Err(error("invalid-input", "input pointer is null"));
    }
    // SAFETY: The host supplies a pointer to `length` initialized bytes in the
    // WASM linear memory. The length is checked by the host before calling.
    Ok(unsafe { std::slice::from_raw_parts(ptr, length) })
}

fn json_pointer<T: Serialize>(response: ParseResponse<T>) -> *mut c_char {
    let mut bytes = serde_json::to_vec(&response).expect("serializing parser response cannot fail");
    bytes.push(0);
    let string = CString::from_vec_with_nul(bytes).expect("parser response has no interior NUL");
    string.into_raw()
}

#[unsafe(no_mangle)]
pub extern "C" fn parse_copc_header_json(ptr: *const u8, length: usize) -> *mut c_char {
    let response = match input_slice(ptr, length).and_then(parse_header) {
        Ok(value) => ParseResponse::success(value),
        Err(parse_error) => ParseResponse::failure(parse_error),
    };
    json_pointer(response)
}

#[unsafe(no_mangle)]
pub extern "C" fn parse_root_hierarchy_json(ptr: *const u8, length: usize) -> *mut c_char {
    let response = match input_slice(ptr, length).and_then(parse_root_hierarchy) {
        Ok(value) => ParseResponse::success(value),
        Err(parse_error) => ParseResponse::failure(parse_error),
    };
    json_pointer(response)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn free_parser_json(ptr: *mut c_char) {
    if !ptr.is_null() {
        // SAFETY: `ptr` must be a pointer returned by `json_pointer` and is
        // therefore a valid, NUL-terminated CString allocation.
        unsafe {
            drop(CString::from_raw(ptr));
        }
    }
}

fn into_leaked_bytes(length: usize) -> *mut u8 {
    let mut values = Vec::<u8>::with_capacity(length);
    let ptr = values.as_mut_ptr();
    std::mem::forget(values);
    ptr
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc_bytes(length: usize) -> *mut u8 {
    into_leaked_bytes(length)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc_bytes(ptr: *mut u8, length: usize) {
    if !ptr.is_null() {
        // SAFETY: `ptr` must have been returned by `alloc_bytes(length)`.
        unsafe {
            drop(Vec::from_raw_parts(ptr, 0, length));
        }
    }
}

#[cfg(test)]
mod parser_tests {
    use super::{parse_header, parse_root_hierarchy};

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

fn decode_xyz_to_interleaved_impl(x: &[f64], y: &[f64], z: &[f64], out: &mut [f64]) {
    assert_eq!(x.len(), y.len(), "x/y dimensions must match");
    assert_eq!(x.len(), z.len(), "x/z dimensions must match");
    assert_eq!(out.len(), x.len() * 3, "output buffer must be count * 3");

    for index in 0..x.len() {
        let offset = index * 3;
        out[offset] = x[index];
        out[offset + 1] = y[index];
        out[offset + 2] = z[index];
    }
}

fn into_leaked_f64_buffer(length: usize) -> *mut f64 {
    let mut values = Vec::<f64>::with_capacity(length);
    let ptr = values.as_mut_ptr();
    std::mem::forget(values);
    ptr
}

fn reclaim_f64_buffer(ptr: *mut f64, length: usize) {
    if ptr.is_null() {
        return;
    }

    // SAFETY:
    // `ptr` must have been returned by `into_leaked_f64_buffer(length)` with the
    // same `length`, so reconstructing the allocation here is valid.
    unsafe {
        let _ = Vec::from_raw_parts(ptr, 0, length);
    }
}

fn f64_input_slice<'a>(ptr: *const f64, length: usize) -> &'a [f64] {
    // SAFETY:
    // The JS caller allocates `length` f64 values in wasm linear memory and
    // passes a non-null pointer to that initialized region.
    unsafe { std::slice::from_raw_parts(ptr, length) }
}

fn f64_output_slice<'a>(ptr: *mut f64, length: usize) -> &'a mut [f64] {
    // SAFETY:
    // The JS caller allocates `length` f64 values in wasm linear memory and
    // passes a non-null mutable pointer to that writable region.
    unsafe { std::slice::from_raw_parts_mut(ptr, length) }
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc_f64(length: usize) -> *mut f64 {
    into_leaked_f64_buffer(length)
}

#[unsafe(no_mangle)]
pub extern "C" fn dealloc_f64(ptr: *mut f64, length: usize) {
    reclaim_f64_buffer(ptr, length);
}

#[unsafe(no_mangle)]
pub extern "C" fn decode_xyz_to_interleaved(
    x_ptr: *const f64,
    y_ptr: *const f64,
    z_ptr: *const f64,
    count: usize,
    out_ptr: *mut f64,
) -> usize {
    if x_ptr.is_null() || y_ptr.is_null() || z_ptr.is_null() || out_ptr.is_null() {
        return 0;
    }

    let x = f64_input_slice(x_ptr, count);
    let y = f64_input_slice(y_ptr, count);
    let z = f64_input_slice(z_ptr, count);
    let out = f64_output_slice(out_ptr, count * 3);

    decode_xyz_to_interleaved_impl(x, y, z, out);

    count * 3
}

#[cfg(test)]
mod tests {
    use super::decode_xyz_to_interleaved_impl;

    #[test]
    fn decodes_xyz_slices_to_interleaved_triples() {
        let x = [1.0, 4.0];
        let y = [2.0, 5.0];
        let z = [3.0, 6.0];
        let mut out = [0.0; 6];

        decode_xyz_to_interleaved_impl(&x, &y, &z, &mut out);

        assert_eq!(out, [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
    }
}
