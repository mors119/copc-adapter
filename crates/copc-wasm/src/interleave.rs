pub(crate) fn decode_xyz_to_interleaved_impl(x: &[f64], y: &[f64], z: &[f64], out: &mut [f64]) {
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
