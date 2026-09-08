use crate::error::{ParseError, error};

fn checked_byte_length<T>(length: usize, what: &str) -> Result<(), ParseError> {
    let byte_length = length
        .checked_mul(std::mem::size_of::<T>())
        .ok_or_else(|| error("overflow", format!("{what} byte length overflows")))?;
    if byte_length > isize::MAX as usize {
        return Err(error(
            "overflow",
            format!("{what} byte length exceeds isize::MAX"),
        ));
    }
    Ok(())
}

pub(crate) fn mutable_f64_slice<'a>(
    ptr: *mut f64,
    length: usize,
) -> Result<&'a mut [f64], ParseError> {
    checked_byte_length::<f64>(length, "f64 output")?;
    if length == 0 {
        return Ok(&mut []);
    }
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
    checked_byte_length::<u16>(length, "u16 output")?;
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
    checked_byte_length::<u8>(length, "u8 output")?;
    if ptr.is_null() {
        return Err(error("invalid-input", "u8 output pointer is null"));
    }
    // SAFETY: the FFI caller checked that `ptr` is non-null and allocated at
    // least `length` writable u8 values in this module's linear memory.
    Ok(unsafe { std::slice::from_raw_parts_mut(ptr, length) })
}

pub(crate) fn input_slice<'a>(ptr: *const u8, length: usize) -> Result<&'a [u8], ParseError> {
    checked_byte_length::<u8>(length, "input")?;
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
    let mut values = Vec::<u8>::new();
    if values.try_reserve_exact(length).is_err() {
        return std::ptr::null_mut();
    }
    let ptr = values.as_mut_ptr();
    std::mem::forget(values);
    ptr
}

pub(crate) fn into_leaked_f64_buffer(length: usize) -> *mut f64 {
    into_leaked_buffer(length)
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

pub(crate) fn checked_f64_input_slice<'a>(
    ptr: *const f64,
    length: usize,
) -> Result<&'a [f64], ParseError> {
    checked_byte_length::<f64>(length, "f64 input")?;
    if length == 0 {
        return Ok(&[]);
    }
    if ptr.is_null() {
        return Err(error("invalid-input", "coordinate input pointer is null"));
    }
    // SAFETY: the FFI caller supplied a non-null pointer to `length`
    // initialized, properly aligned f64 values in linear memory.
    Ok(unsafe { std::slice::from_raw_parts(ptr, length) })
}

pub(crate) fn into_leaked_buffer<T>(length: usize) -> *mut T {
    let mut values = Vec::<T>::new();
    if values.try_reserve_exact(length).is_err() {
        return std::ptr::null_mut();
    }
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

#[cfg(test)]
mod tests {
    use super::{checked_f64_input_slice, input_slice, into_leaked_bytes, mutable_f64_slice};

    #[test]
    fn maps_invalid_pointers_and_byte_lengths_to_errors() {
        assert_eq!(
            input_slice(std::ptr::null(), 1).unwrap_err().code,
            "invalid-input"
        );
        assert_eq!(
            checked_f64_input_slice(std::ptr::NonNull::<f64>::dangling().as_ptr(), usize::MAX)
                .unwrap_err()
                .code,
            "overflow"
        );
        assert_eq!(
            mutable_f64_slice(std::ptr::null_mut(), 1).unwrap_err().code,
            "invalid-input"
        );
    }

    #[test]
    fn allocation_failure_returns_null_without_panicking() {
        assert!(into_leaked_bytes(usize::MAX).is_null());
    }
}
