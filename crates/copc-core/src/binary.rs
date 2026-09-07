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

pub(crate) fn read_u16(bytes: &[u8], offset: usize, what: &str) -> Result<u16> {
    ensure_range(bytes, offset, 2, what)?;
    Ok(u16::from_le_bytes([bytes[offset], bytes[offset + 1]]))
}

pub(crate) fn read_u32(bytes: &[u8], offset: usize, what: &str) -> Result<u32> {
    ensure_range(bytes, offset, 4, what)?;
    Ok(u32::from_le_bytes(
        bytes[offset..offset + 4].try_into().unwrap(),
    ))
}

pub(crate) fn read_i32(bytes: &[u8], offset: usize, what: &str) -> Result<i32> {
    ensure_range(bytes, offset, 4, what)?;
    Ok(i32::from_le_bytes(
        bytes[offset..offset + 4].try_into().unwrap(),
    ))
}

pub(crate) fn read_u64(bytes: &[u8], offset: usize, what: &str) -> Result<u64> {
    ensure_range(bytes, offset, 8, what)?;
    Ok(u64::from_le_bytes(
        bytes[offset..offset + 8].try_into().unwrap(),
    ))
}

pub(crate) fn read_i64(bytes: &[u8], offset: usize, what: &str) -> Result<i64> {
    ensure_range(bytes, offset, 8, what)?;
    Ok(i64::from_le_bytes(
        bytes[offset..offset + 8].try_into().unwrap(),
    ))
}

pub(crate) fn read_f64(bytes: &[u8], offset: usize, what: &str) -> Result<f64> {
    ensure_range(bytes, offset, 8, what)?;
    let value = f64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap());
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
