use crate::error::{CopcError, Result};

pub(crate) fn ensure_range(bytes: &[u8], start: usize, length: usize, what: &str) -> Result<()> {
    let end = start.checked_add(length).ok_or_else(|| {
        CopcError::new(
            "overflow",
            format!("{what} range overflows the addressable input"),
        )
    })?;

    if end > bytes.len() {
        return Err(CopcError::new(
            "truncated",
            format!(
                "{what} requires bytes through {end}, input has {}",
                bytes.len()
            ),
        ));
    }

    Ok(())
}

pub(crate) fn read_array<const N: usize>(
    bytes: &[u8],
    offset: usize,
    what: &str,
) -> Result<[u8; N]> {
    let end = offset.checked_add(N).ok_or_else(|| {
        CopcError::new(
            "overflow",
            format!("{what} range overflows the addressable input"),
        )
    })?;
    let slice = bytes.get(offset..end).ok_or_else(|| {
        CopcError::new(
            "truncated",
            format!(
                "{what} requires bytes through {end}, input has {}",
                bytes.len()
            ),
        )
    })?;
    slice
        .try_into()
        .map_err(|_| CopcError::new("truncated", format!("{what} has an invalid byte length")))
}

pub(crate) fn read_u16(bytes: &[u8], offset: usize, what: &str) -> Result<u16> {
    Ok(u16::from_le_bytes(read_array(bytes, offset, what)?))
}

pub(crate) fn read_u32(bytes: &[u8], offset: usize, what: &str) -> Result<u32> {
    Ok(u32::from_le_bytes(read_array(bytes, offset, what)?))
}

pub(crate) fn read_i32(bytes: &[u8], offset: usize, what: &str) -> Result<i32> {
    Ok(i32::from_le_bytes(read_array(bytes, offset, what)?))
}

pub(crate) fn read_u64(bytes: &[u8], offset: usize, what: &str) -> Result<u64> {
    Ok(u64::from_le_bytes(read_array(bytes, offset, what)?))
}

pub(crate) fn read_i64(bytes: &[u8], offset: usize, what: &str) -> Result<i64> {
    Ok(i64::from_le_bytes(read_array(bytes, offset, what)?))
}

pub(crate) fn read_f64(bytes: &[u8], offset: usize, what: &str) -> Result<f64> {
    let value = f64::from_le_bytes(read_array(bytes, offset, what)?);
    if !value.is_finite() {
        return Err(CopcError::new(
            "invalid-value",
            format!("{what} is not finite"),
        ));
    }
    Ok(value)
}

pub(crate) fn las_string(bytes: &[u8]) -> String {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::{read_array, read_f64};

    #[test]
    fn reports_truncated_and_overflowing_binary_ranges() {
        assert_eq!(
            read_array::<4>(&[1, 2, 3], 0, "primitive")
                .unwrap_err()
                .code(),
            "truncated"
        );
        assert_eq!(
            read_array::<4>(&[], usize::MAX, "primitive")
                .unwrap_err()
                .code(),
            "overflow"
        );
    }

    #[test]
    fn preserves_finite_value_validation() {
        assert_eq!(
            read_f64(&f64::NAN.to_le_bytes(), 0, "coordinate")
                .unwrap_err()
                .code(),
            "invalid-value"
        );
    }
}
