use serde::Serialize;
use std::ffi::{CString, c_char};

use crate::decoder::decode_copc_node_impl;
use crate::error::ParseResponse;
use crate::header::parse_header;
use crate::hierarchy::parse_root_hierarchy;
use crate::interleave::decode_xyz_to_interleaved_impl;
use crate::memory::{
    f64_input_slice, f64_output_slice, input_slice, into_leaked_buffer, into_leaked_bytes,
    into_leaked_f64_buffer, reclaim_buffer, reclaim_bytes, reclaim_f64_buffer,
};

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

/// Decode one COPC node chunk using only the LAS metadata and the exact range
/// returned for that hierarchy entry.
///
/// `requested_fields` uses bit 0 for intensity, bit 1 for classification, and
/// bit 2 for RGB. XYZ is always decoded. Output arrays are owned by the host;
/// this function only writes into them and returns a small JSON status object.
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
        (Ok(metadata), Ok(chunk)) => decode_copc_node_impl(
            metadata,
            chunk,
            point_count,
            requested_fields,
            coordinates_ptr,
            intensity_ptr,
            classification_ptr,
            red_ptr,
            green_ptr,
            blue_ptr,
        )
        .map(ParseResponse::success)
        .unwrap_or_else(ParseResponse::failure),
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
