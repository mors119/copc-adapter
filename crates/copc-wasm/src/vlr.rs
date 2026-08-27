use crate::binary::{ensure_range, las_string, read_u16};
use crate::error::{ParseError, error};

pub(crate) const VLR_HEADER_SIZE: usize = 54;

pub(crate) enum VlrVisit {
    Continue,
    Stop,
}

pub(crate) fn for_each_vlr<F>(
    bytes: &[u8],
    header_size: usize,
    point_data_offset: usize,
    number_of_vlrs: usize,
    payload_offset_error: &'static str,
    mut visit: F,
) -> Result<(), ParseError>
where
    F: FnMut(&str, u16, &[u8]) -> Result<VlrVisit, ParseError>,
{
    let mut position = header_size;
    for _ in 0..number_of_vlrs {
        ensure_range(bytes, position, VLR_HEADER_SIZE, "VLR header")?;
        let record_user_id = las_string(&bytes[position + 2..position + 18]);
        let record_id = read_u16(bytes, position + 18, "VLR record ID")?;
        let record_length = read_u16(bytes, position + 20, "VLR record length")? as usize;
        let payload_start = position
            .checked_add(VLR_HEADER_SIZE)
            .ok_or_else(|| error("overflow", payload_offset_error))?;
        ensure_range(bytes, payload_start, record_length, "VLR payload")?;
        let payload_end = payload_start + record_length;
        if payload_end > point_data_offset {
            return Err(error("invalid-header", "VLR payload overlaps point data"));
        }

        if matches!(
            visit(
                &record_user_id,
                record_id,
                &bytes[payload_start..payload_end]
            )?,
            VlrVisit::Stop
        ) {
            return Ok(());
        }
        position = payload_end;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{VLR_HEADER_SIZE, VlrVisit, for_each_vlr};

    fn put_u16(bytes: &mut [u8], offset: usize, value: u16) {
        bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
    }

    #[test]
    fn rejects_truncated_vlr_header_and_payload() {
        let mut bytes = vec![0; VLR_HEADER_SIZE - 1];
        assert_eq!(
            for_each_vlr(
                &bytes,
                0,
                bytes.len(),
                1,
                "VLR payload offset overflows the input",
                |_, _, _| { Ok(VlrVisit::Continue) }
            )
            .unwrap_err()
            .code,
            "truncated"
        );

        bytes.resize(VLR_HEADER_SIZE, 0);
        put_u16(&mut bytes, 20, 1);
        assert_eq!(
            for_each_vlr(
                &bytes,
                0,
                bytes.len(),
                1,
                "VLR payload offset overflows the input",
                |_, _, _| { Ok(VlrVisit::Continue) }
            )
            .unwrap_err()
            .code,
            "truncated"
        );
    }

    #[test]
    fn rejects_vlr_payload_that_crosses_point_data() {
        let mut bytes = vec![0; VLR_HEADER_SIZE + 1];
        put_u16(&mut bytes, 20, 1);
        assert_eq!(
            for_each_vlr(
                &bytes,
                0,
                VLR_HEADER_SIZE,
                1,
                "VLR payload offset overflows the input",
                |_, _, _| { Ok(VlrVisit::Continue) }
            )
            .unwrap_err()
            .code,
            "invalid-header"
        );
    }

    #[test]
    fn rejects_vlr_header_offset_overflow() {
        assert_eq!(
            for_each_vlr(
                &[],
                usize::MAX,
                0,
                1,
                "VLR payload offset overflows the input",
                |_, _, _| { Ok(VlrVisit::Continue) }
            )
            .unwrap_err()
            .code,
            "overflow"
        );
    }
}
