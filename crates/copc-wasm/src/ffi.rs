use copc_core::{
    CopcHeader, CrsTransform, RootHierarchy, decode_copc_node, interleave_xyz, parse_header,
    parse_root_hierarchy,
};
use serde::Serialize;
use std::ffi::{CString, c_char};

use crate::error::{ParseError, ParseResponse, error, from_core};
use crate::memory::{
    checked_f64_input_slice, f64_input_slice, f64_output_slice, input_slice, into_leaked_buffer,
    into_leaked_bytes, into_leaked_f64_buffer, mutable_f64_slice, mutable_u8_slice,
    mutable_u16_slice, reclaim_buffer, reclaim_bytes, reclaim_f64_buffer,
};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Serialize)]
struct CopcHeaderJson {
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
struct RootHierarchyJson {
    entry_count: usize,
    nodes: Vec<RootHierarchyNodeJson>,
    pages: Vec<RootHierarchyPageJson>,
}

#[derive(Debug, Serialize)]
struct RootHierarchyNodeJson {
    level: i32,
    x: i32,
    y: i32,
    z: i32,
    point_data_offset: u64,
    point_data_length: u32,
    point_count: u32,
}

#[derive(Debug, Serialize)]
struct RootHierarchyPageJson {
    level: i32,
    x: i32,
    y: i32,
    z: i32,
    page_offset: u64,
    page_length: u32,
}

#[derive(Debug, Serialize)]
struct DecodeResult {
    point_count: usize,
    intensity: bool,
    classification: bool,
    rgb: bool,
}

#[derive(Debug, Serialize)]
struct CrsTransformHandle {
    handle: usize,
    vertical_unit_scale: f64,
    used_horizontal_fallback: bool,
}

#[derive(Debug, Serialize)]
struct CrsTransformResult {
    point_count: usize,
}

fn json_pointer<T: Serialize>(response: ParseResponse<T>) -> *mut c_char {
    let mut bytes = serde_json::to_vec(&response).expect("serializing parser response cannot fail");
    bytes.push(0);
    let string = CString::from_vec_with_nul(bytes).expect("parser response has no interior NUL");
    string.into_raw()
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

fn safe_range_end(offset: u64, length: u64, what: &str) -> Result<(), ParseError> {
    let end = offset
        .checked_add(length)
        .ok_or_else(|| error("overflow", format!("{what} overflows")))?;
    safe_u64(end, what)?;
    Ok(())
}

fn header_json(value: CopcHeader) -> Result<CopcHeaderJson, ParseError> {
    let point_count = safe_u64(value.point_count, "point count")?;
    let root_offset = safe_u64(
        value.root_hierarchy_page_offset,
        "root hierarchy page offset",
    )?;
    let root_length = safe_u64(
        value.root_hierarchy_page_length,
        "root hierarchy page length",
    )?;
    safe_range_end(root_offset, root_length, "root hierarchy page end")?;

    Ok(CopcHeaderJson {
        version_major: value.version_major,
        version_minor: value.version_minor,
        point_data_record_format: value.point_data_record_format,
        point_data_record_length: value.point_data_record_length,
        point_count,
        scale: value.scale,
        offset: value.offset,
        bounds: value.bounds,
        cube: value.cube,
        spacing: value.spacing,
        root_hierarchy_page_offset: root_offset,
        root_hierarchy_page_length: root_length,
        wkt: value.wkt,
    })
}

fn validate_header_for_js(value: &CopcHeader) -> Result<(), ParseError> {
    safe_u64(value.point_count, "point count")?;
    let root_offset = safe_u64(
        value.root_hierarchy_page_offset,
        "root hierarchy page offset",
    )?;
    let root_length = safe_u64(
        value.root_hierarchy_page_length,
        "root hierarchy page length",
    )?;
    safe_range_end(root_offset, root_length, "root hierarchy page end")?;
    Ok(())
}

fn hierarchy_json(value: RootHierarchy) -> Result<RootHierarchyJson, ParseError> {
    Ok(RootHierarchyJson {
        entry_count: value.entry_count,
        nodes: value
            .nodes
            .into_iter()
            .map(|node| {
                let point_data_offset = safe_u64(node.point_data_offset, "point data offset")?;
                safe_range_end(
                    point_data_offset,
                    u64::from(node.point_data_length),
                    "hierarchy byte range end",
                )?;
                Ok(RootHierarchyNodeJson {
                    level: node.level,
                    x: node.x,
                    y: node.y,
                    z: node.z,
                    point_data_offset,
                    point_data_length: node.point_data_length,
                    point_count: node.point_count,
                })
            })
            .collect::<Result<Vec<_>, ParseError>>()?,
        pages: value
            .pages
            .into_iter()
            .map(|page| {
                let page_offset = safe_u64(page.page_offset, "hierarchy page offset")?;
                safe_range_end(
                    page_offset,
                    u64::from(page.page_length),
                    "hierarchy byte range end",
                )?;
                Ok(RootHierarchyPageJson {
                    level: page.level,
                    x: page.x,
                    y: page.y,
                    z: page.z,
                    page_offset,
                    page_length: page.page_length,
                })
            })
            .collect::<Result<Vec<_>, ParseError>>()?,
    })
}

fn parse_header_value(bytes: &[u8]) -> Result<CopcHeaderJson, ParseError> {
    parse_header(bytes).map_err(from_core).and_then(header_json)
}

fn parse_hierarchy_value(bytes: &[u8]) -> Result<RootHierarchyJson, ParseError> {
    parse_root_hierarchy(bytes)
        .map_err(from_core)
        .and_then(hierarchy_json)
}

fn create_crs_transform_value(wkt: &str) -> Result<CrsTransformHandle, ParseError> {
    let transform = CrsTransform::from_wkt(wkt).map_err(from_core)?;
    let vertical_unit_scale = transform.vertical_unit_scale();
    let used_horizontal_fallback = transform.used_horizontal_fallback();
    let handle = Box::into_raw(Box::new(transform)) as usize;
    Ok(CrsTransformHandle {
        handle,
        vertical_unit_scale,
        used_horizontal_fallback,
    })
}

fn create_geographic_crs_transform_value() -> Result<CrsTransformHandle, ParseError> {
    let transform = CrsTransform::from_geographic().map_err(from_core)?;
    let vertical_unit_scale = transform.vertical_unit_scale();
    let handle = Box::into_raw(Box::new(transform)) as usize;
    Ok(CrsTransformHandle {
        handle,
        vertical_unit_scale,
        used_horizontal_fallback: false,
    })
}

fn transform_crs_points_value(
    handle: usize,
    input_ptr: *const f64,
    input_length: usize,
    geographic_ptr: *mut f64,
    ecef_ptr: *mut f64,
) -> Result<CrsTransformResult, ParseError> {
    if handle == 0 {
        return Err(error("invalid-input", "CRS transform handle is null"));
    }
    let source = checked_f64_input_slice(input_ptr, input_length)?;
    // SAFETY: the handle is returned by create_crs_transform_json or
    // create_geographic_crs_transform_json and remains live until the caller
    // invokes free_crs_transform.
    let transform = unsafe { &*(handle as *const CrsTransform) };
    let prepared = transform
        .transform_buffer_to_ecef(source)
        .map_err(from_core)?;
    mutable_f64_slice(geographic_ptr, prepared.geographic.len())?
        .copy_from_slice(&prepared.geographic);
    mutable_f64_slice(ecef_ptr, prepared.ecef.len())?.copy_from_slice(&prepared.ecef);
    Ok(CrsTransformResult {
        point_count: prepared.geographic.len() / 3,
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn create_crs_transform_json(ptr: *const u8, length: usize) -> *mut c_char {
    let response = match input_slice(ptr, length)
        .and_then(|bytes| {
            std::str::from_utf8(bytes)
                .map_err(|_| error("malformed-wkt", "CRS WKT is not valid UTF-8"))
        })
        .and_then(create_crs_transform_value)
    {
        Ok(value) => ParseResponse::success(value),
        Err(parse_error) => ParseResponse::failure(parse_error),
    };
    json_pointer(response)
}

#[unsafe(no_mangle)]
pub extern "C" fn create_geographic_crs_transform_json() -> *mut c_char {
    let response = match create_geographic_crs_transform_value() {
        Ok(value) => ParseResponse::success(value),
        Err(parse_error) => ParseResponse::failure(parse_error),
    };
    json_pointer(response)
}

#[unsafe(no_mangle)]
pub extern "C" fn transform_crs_points_json(
    handle: usize,
    input_ptr: *const f64,
    input_length: usize,
    geographic_ptr: *mut f64,
    ecef_ptr: *mut f64,
) -> *mut c_char {
    let response =
        match transform_crs_points_value(handle, input_ptr, input_length, geographic_ptr, ecef_ptr)
        {
            Ok(value) => ParseResponse::success(value),
            Err(parse_error) => ParseResponse::failure(parse_error),
        };
    json_pointer(response)
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `handle` must be a value returned by a CRS transform creation function and
/// must not be freed more than once or used after this call.
pub unsafe extern "C" fn free_crs_transform(handle: usize) {
    if handle != 0 {
        // SAFETY: the caller guarantees that this handle came from Box::into_raw
        // in a CRS transform creation function and is freed exactly once.
        unsafe {
            drop(Box::from_raw(handle as *mut CrsTransform));
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn parse_copc_header_json(ptr: *const u8, length: usize) -> *mut c_char {
    let response = match input_slice(ptr, length).and_then(parse_header_value) {
        Ok(value) => ParseResponse::success(value),
        Err(parse_error) => ParseResponse::failure(parse_error),
    };
    json_pointer(response)
}

#[unsafe(no_mangle)]
pub extern "C" fn parse_root_hierarchy_json(ptr: *const u8, length: usize) -> *mut c_char {
    let response = match input_slice(ptr, length).and_then(parse_hierarchy_value) {
        Ok(value) => ParseResponse::success(value),
        Err(parse_error) => ParseResponse::failure(parse_error),
    };
    json_pointer(response)
}

fn copy_decoded_node(
    decoded: copc_core::DecodedCopcNode,
    coordinates_ptr: *mut f64,
    intensity_ptr: *mut u16,
    classification_ptr: *mut u8,
    red_ptr: *mut u16,
    green_ptr: *mut u16,
    blue_ptr: *mut u16,
) -> Result<DecodeResult, ParseError> {
    let coordinate_length = decoded
        .point_count
        .checked_mul(3)
        .ok_or_else(|| error("overflow", "coordinate output length overflows"))?;
    mutable_f64_slice(coordinates_ptr, coordinate_length)?.copy_from_slice(&decoded.coordinates);

    let intensity_present = decoded.intensity.is_some();
    if let Some(values) = decoded.intensity {
        mutable_u16_slice(intensity_ptr, decoded.point_count)?.copy_from_slice(&values);
    }
    let classification_present = decoded.classification.is_some();
    if let Some(values) = decoded.classification {
        mutable_u8_slice(classification_ptr, decoded.point_count)?.copy_from_slice(&values);
    }
    let rgb_present = decoded.red.is_some();
    if let Some(values) = decoded.red {
        mutable_u16_slice(red_ptr, decoded.point_count)?.copy_from_slice(&values);
    }
    if let Some(values) = decoded.green {
        mutable_u16_slice(green_ptr, decoded.point_count)?.copy_from_slice(&values);
    }
    if let Some(values) = decoded.blue {
        mutable_u16_slice(blue_ptr, decoded.point_count)?.copy_from_slice(&values);
    }

    Ok(DecodeResult {
        point_count: decoded.point_count,
        intensity: intensity_present,
        classification: classification_present,
        rgb: rgb_present,
    })
}

/// Decode one COPC node chunk using only the LAS metadata and the exact range
/// returned for that hierarchy entry.
///
/// `requested_fields` uses bit 0 for intensity, bit 1 for classification, and
/// bit 2 for RGB. XYZ is always decoded. Output arrays are owned by the host;
/// this function only copies core-owned results into them and returns a small
/// JSON status object.
#[unsafe(no_mangle)]
pub extern "C" fn decode_copc_node_json(
    metadata_ptr: *const u8,
    metadata_length: usize,
    chunk_ptr: *const u8,
    chunk_length: usize,
    point_count: usize,
    requested_fields: u32,
    coordinates_ptr: *mut f64,
    intensity_ptr: *mut u16,
    classification_ptr: *mut u8,
    red_ptr: *mut u16,
    green_ptr: *mut u16,
    blue_ptr: *mut u16,
) -> *mut c_char {
    let response = match (
        input_slice(metadata_ptr, metadata_length),
        input_slice(chunk_ptr, chunk_length),
    ) {
        (Ok(metadata), Ok(chunk)) => {
            decode_copc_node(metadata, chunk, point_count, requested_fields)
                .map_err(from_core)
                .and_then(|decoded| {
                    parse_header(metadata)
                        .map_err(from_core)
                        .and_then(|header| validate_header_for_js(&header).map(|()| decoded))
                        .and_then(|decoded| {
                            copy_decoded_node(
                                decoded,
                                coordinates_ptr,
                                intensity_ptr,
                                classification_ptr,
                                red_ptr,
                                green_ptr,
                                blue_ptr,
                            )
                        })
                })
                .map(ParseResponse::success)
                .unwrap_or_else(ParseResponse::failure)
        }
        (Err(parse_error), _) | (_, Err(parse_error)) => ParseResponse::failure(parse_error),
    };
    json_pointer(response)
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `ptr` must be a pointer returned by `parse_copc_header_json`,
/// `parse_root_hierarchy_json`, or `decode_copc_node_json` and must not be
/// freed more than once.
pub unsafe extern "C" fn free_parser_json(ptr: *mut c_char) {
    if !ptr.is_null() {
        // SAFETY: `ptr` must be a pointer returned by `json_pointer` and is
        // therefore a valid, NUL-terminated CString allocation.
        unsafe {
            drop(CString::from_raw(ptr));
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc_bytes(length: usize) -> *mut u8 {
    into_leaked_bytes(length)
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `ptr` must be a pointer returned by `alloc_bytes(length)` with the same
/// `length`, and must not be deallocated more than once.
pub unsafe extern "C" fn dealloc_bytes(ptr: *mut u8, length: usize) {
    reclaim_bytes(ptr, length);
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
    let Some(output_length) = count.checked_mul(3) else {
        return 0;
    };
    if x_ptr.is_null() || y_ptr.is_null() || z_ptr.is_null() || out_ptr.is_null() {
        return 0;
    }

    let x = f64_input_slice(x_ptr, count);
    let y = f64_input_slice(y_ptr, count);
    let z = f64_input_slice(z_ptr, count);
    let out = f64_output_slice(out_ptr, output_length);
    let Ok(values) = interleave_xyz(x, y, z) else {
        return 0;
    };
    out.copy_from_slice(&values);
    output_length
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc_u16(length: usize) -> *mut u16 {
    into_leaked_buffer(length)
}

#[unsafe(no_mangle)]
pub extern "C" fn dealloc_u16(ptr: *mut u16, length: usize) {
    reclaim_buffer(ptr, length);
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc_u8(length: usize) -> *mut u8 {
    into_leaked_buffer(length)
}

#[unsafe(no_mangle)]
pub extern "C" fn dealloc_u8(ptr: *mut u8, length: usize) {
    reclaim_buffer(ptr, length);
}

#[cfg(test)]
mod tests {
    use super::{create_crs_transform_value, free_crs_transform, transform_crs_points_value};

    const WGS84_GEOGRAPHIC_WKT: &str = "GEOGCS[\"WGS 84\",DATUM[\"WGS_1984\",SPHEROID[\"WGS 84\",6378137,298.257223563]],PRIMEM[\"Greenwich\",0],UNIT[\"degree\",0.0174532925199433]]";

    #[test]
    fn reuses_a_crs_handle_and_copies_geographic_and_ecef_outputs() {
        let handle = create_crs_transform_value(WGS84_GEOGRAPHIC_WKT)
            .expect("WKT should initialize")
            .handle;
        let input = [10.25, 20.5, 100.0];
        let mut geographic = [0.0; 3];
        let mut ecef = [0.0; 3];
        let result = transform_crs_points_value(
            handle,
            input.as_ptr(),
            input.len(),
            geographic.as_mut_ptr(),
            ecef.as_mut_ptr(),
        )
        .expect("transform should succeed");

        assert_eq!(result.point_count, 1);
        assert!((geographic[0] - input[0]).abs() < 1e-12);
        assert!((geographic[1] - input[1]).abs() < 1e-12);
        assert_eq!(geographic[2], input[2]);
        assert!(ecef.iter().all(|value| value.is_finite()));

        // SAFETY: the handle was returned by create_crs_transform_value and is
        // freed exactly once in this test.
        unsafe { free_crs_transform(handle) };
    }

    #[test]
    fn maps_invalid_crs_buffer_pointers_to_structured_errors() {
        let handle = create_crs_transform_value(WGS84_GEOGRAPHIC_WKT)
            .expect("WKT should initialize")
            .handle;
        let error = transform_crs_points_value(
            handle,
            std::ptr::null(),
            3,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
        .expect_err("null input must fail");
        assert_eq!(error.code, "invalid-input");

        // SAFETY: the handle was returned by create_crs_transform_value and is
        // freed exactly once in this test.
        unsafe { free_crs_transform(handle) };
    }
}
