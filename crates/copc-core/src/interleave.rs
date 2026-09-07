use crate::error::{CopcError, Result};

pub fn interleave_xyz(x: &[f64], y: &[f64], z: &[f64]) -> Result<Vec<f64>> {
    if x.len() != y.len() || x.len() != z.len() {
        return Err(CopcError::new(
            "invalid-value",
            "x, y, and z dimensions must have the same length",
        ));
    }
    let output_length = x
        .len()
        .checked_mul(3)
        .ok_or_else(|| CopcError::new("overflow", "interleaved output length overflows"))?;
    let mut out = vec![0.0; output_length];
    for index in 0..x.len() {
        let offset = index * 3;
        out[offset] = x[index];
        out[offset + 1] = y[index];
        out[offset + 2] = z[index];
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::interleave_xyz;

    #[test]
    fn interleaves_xyz_slices_to_triples() {
        assert_eq!(
            interleave_xyz(&[1.0, 4.0], &[2.0, 5.0], &[3.0, 6.0]).unwrap(),
            [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]
        );
    }

    #[test]
    fn rejects_mismatched_dimensions() {
        assert_eq!(
            interleave_xyz(&[1.0], &[], &[3.0]).unwrap_err().code(),
            "invalid-value"
        );
    }
}
