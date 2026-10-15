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
    let mut out = Vec::new();
    out.try_reserve_exact(output_length)
        .map_err(|_| CopcError::new("allocation", "unable to allocate interleaved output"))?;
    out.resize(output_length, 0.0);
    for (index, ((x_value, y_value), z_value)) in x.iter().zip(y).zip(z).enumerate() {
        let offset = index
            .checked_mul(3)
            .ok_or_else(|| CopcError::new("overflow", "interleaved output offset overflows"))?;
        let end = offset
            .checked_add(3)
            .ok_or_else(|| CopcError::new("overflow", "interleaved output range overflows"))?;
        let values = out.get_mut(offset..end).ok_or_else(|| {
            CopcError::new(
                "invalid-value",
                "interleaved output dimensions are inconsistent",
            )
        })?;
        values.copy_from_slice(&[*x_value, *y_value, *z_value]);
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
