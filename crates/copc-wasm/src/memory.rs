use crate::error::{ParseError, error};

pub(crate) fn mutable_f64_slice<'a>(
    ptr: *mut f64,
    length: usize,
) -> Result<&'a mut [f64], ParseError> {
    if ptr.is_null() {
        return Err(error("invalid-input", "coordinate output pointer is null"));
    }
    // SAFETY: the FFI caller checked that `ptr` is non-null and allocated at
    // least `length` writable, properly aligned f64 values in this module's
    // linear memory.
    Ok(unsafe { std::slice::from_raw_parts_mut(ptr, length) })
}

pub(crate) fn mutable_u16_slice<'a>(
    ptr: *mut u16,
    length: usize,
) -> Result<&'a mut [u16], ParseError> {
    if ptr.is_null() {
        return Err(error("invalid-input", "u16 output pointer is null"));
    }
    // SAFETY: the FFI caller checked that `ptr` is non-null and allocated at
    // least `length` writable, properly aligned u16 values in this module's
    // linear memory.
    Ok(unsafe { std::slice::from_raw_parts_mut(ptr, length) })
}

pub(crate) fn mutable_u8_slice<'a>(
    ptr: *mut u8,
    length: usize,
) -> Result<&'a mut [u8], ParseError> {
    if ptr.is_null() {
        return Err(error("invalid-input", "u8 output pointer is null"));
    }
    // SAFETY: the FFI caller checked that `ptr` is non-null and allocated at
    // least `length` writable u8 values in this module's linear memory.
    Ok(unsafe { std::slice::from_raw_parts_mut(ptr, length) })
}

pub(crate) fn input_slice<'a>(ptr: *const u8, length: usize) -> Result<&'a [u8], ParseError> {
    if length == 0 {
        return Ok(&[]);
    }
    if ptr.is_null() {
        return Err(error("invalid-input", "input pointer is null"));
    }
    // SAFETY: the FFI caller checked that `ptr` is non-null and points to at
    // least `length` initialized bytes in this module's linear memory.
    Ok(unsafe { std::slice::from_raw_parts(ptr, length) })
}

pub(crate) fn into_leaked_bytes(length: usize) -> *mut u8 {
    let mut values = Vec::<u8>::with_capacity(length);
    let ptr = values.as_mut_ptr();
    std::mem::forget(values);
    ptr
}

pub(crate) fn into_leaked_f64_buffer(length: usize) -> *mut f64 {
    let mut values = Vec::<f64>::with_capacity(length);
    let ptr = values.as_mut_ptr();
    std::mem::forget(values);
    ptr
}

pub(crate) fn reclaim_f64_buffer(ptr: *mut f64, length: usize) {
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

pub(crate) fn f64_input_slice<'a>(ptr: *const f64, length: usize) -> &'a [f64] {
    // SAFETY: the FFI caller checks all three input pointers for non-null and
    // supplies `length` initialized, properly aligned f64 values in linear
    // memory.
    unsafe { std::slice::from_raw_parts(ptr, length) }
}

pub(crate) fn f64_output_slice<'a>(ptr: *mut f64, length: usize) -> &'a mut [f64] {
    // SAFETY: the FFI caller checks the output pointer for non-null and
    // supplies `length` writable, properly aligned f64 values in linear
    // memory.
    unsafe { std::slice::from_raw_parts_mut(ptr, length) }
}

pub(crate) fn into_leaked_buffer<T>(length: usize) -> *mut T {
    let mut values = Vec::<T>::with_capacity(length);
    let ptr = values.as_mut_ptr();
    std::mem::forget(values);
    ptr
}

pub(crate) fn reclaim_buffer<T>(ptr: *mut T, length: usize) {
    if !ptr.is_null() {
        // SAFETY: `ptr` must have been returned by `into_leaked_buffer(length)`.
        unsafe {
            drop(Vec::from_raw_parts(ptr, 0, length));
        }
    }
}

pub(crate) fn reclaim_bytes(ptr: *mut u8, length: usize) {
    if !ptr.is_null() {
        // SAFETY: ptr must have been returned by alloc_bytes(length).
        unsafe {
            drop(Vec::from_raw_parts(ptr, 0, length));
        }
    }
}
