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

#[unsafe(no_mangle)]
pub extern "C" fn alloc_f64(length: usize) -> *mut f64 {
    let mut values = Vec::<f64>::with_capacity(length);
    let ptr = values.as_mut_ptr();
    std::mem::forget(values);
    ptr
}

#[unsafe(no_mangle)]
pub extern "C" fn dealloc_f64(ptr: *mut f64, length: usize) {
    if ptr.is_null() {
        return;
    }

    unsafe {
        let _ = Vec::from_raw_parts(ptr, 0, length);
    }
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

    let x = unsafe { std::slice::from_raw_parts(x_ptr, count) };
    let y = unsafe { std::slice::from_raw_parts(y_ptr, count) };
    let z = unsafe { std::slice::from_raw_parts(z_ptr, count) };
    let out = unsafe { std::slice::from_raw_parts_mut(out_ptr, count * 3) };

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
