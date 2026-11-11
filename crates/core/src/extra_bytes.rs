use std::collections::HashSet;

use crate::binary::{read_f64, read_i64, read_u64};
use crate::error::{CopcError, Result};

pub(crate) const EXTRA_BYTES_DESCRIPTOR_SIZE: usize = 192;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtraBytesPrimitive {
    U8,
    I8,
    U16,
    I16,
    U32,
    I32,
    U64,
    I64,
    F32,
    F64,
}

impl ExtraBytesPrimitive {
    pub fn metadata_type(self) -> &'static str {
        match self {
            Self::U8 | Self::U16 | Self::U32 | Self::U64 => "unsigned",
            Self::I8 | Self::I16 | Self::I32 | Self::I64 => "signed",
            Self::F32 | Self::F64 => "float",
        }
    }

    pub fn byte_width(self) -> usize {
        match self {
            Self::U8 | Self::I8 => 1,
            Self::U16 | Self::I16 => 2,
            Self::U32 | Self::I32 | Self::F32 => 4,
            Self::U64 | Self::I64 | Self::F64 => 8,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ExtraBytesValue {
    Unsigned(u64),
    Signed(i64),
    Float(f64),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExtraBytesDescriptor {
    pub name: String,
    pub data_type: u8,
    pub primitive: Option<ExtraBytesPrimitive>,
    pub element_count: u8,
    pub byte_offset: usize,
    pub length: usize,
    pub scale: Option<f64>,
    pub offset: Option<f64>,
    pub no_data: Option<ExtraBytesValue>,
}

impl ExtraBytesDescriptor {
    pub fn is_supported_scalar(&self) -> bool {
        self.primitive.is_some() && self.element_count == 1
    }

    pub fn decoded_no_data(&self) -> Option<f64> {
        let no_data = self.no_data.as_ref()?;
        let scale = self.scale.unwrap_or(1.0);
        let offset = self.offset.unwrap_or(0.0);
        let raw = match no_data {
            ExtraBytesValue::Unsigned(value) => *value as f64,
            ExtraBytesValue::Signed(value) => *value as f64,
            ExtraBytesValue::Float(value) => *value,
        };
        let value = raw * scale + offset;
        value.is_finite().then_some(value)
    }

    pub fn exact_no_data_string(&self) -> Option<String> {
        if self.scale.unwrap_or(1.0) != 1.0 || self.offset.unwrap_or(0.0) != 0.0 {
            return None;
        }
        match self.no_data.as_ref()? {
            ExtraBytesValue::Unsigned(value) if *value > 9_007_199_254_740_991 => {
                Some(value.to_string())
            }
            ExtraBytesValue::Signed(value)
                if *value > 9_007_199_254_740_991 || *value < -9_007_199_254_740_991 =>
            {
                Some(value.to_string())
            }
            _ => None,
        }
    }
}

fn invalid_descriptor(message: impl Into<String>) -> CopcError {
    CopcError::new("malformed-extra-bytes", message)
}

fn primitive_for_type(data_type: u8) -> Option<ExtraBytesPrimitive> {
    Some(match data_type {
        1 => ExtraBytesPrimitive::U8,
        2 => ExtraBytesPrimitive::I8,
        3 => ExtraBytesPrimitive::U16,
        4 => ExtraBytesPrimitive::I16,
        5 => ExtraBytesPrimitive::U32,
        6 => ExtraBytesPrimitive::I32,
        7 => ExtraBytesPrimitive::U64,
        8 => ExtraBytesPrimitive::I64,
        9 => ExtraBytesPrimitive::F32,
        10 => ExtraBytesPrimitive::F64,
        _ => return None,
    })
}

fn read_no_data(bytes: &[u8], primitive: ExtraBytesPrimitive) -> Result<ExtraBytesValue> {
    // LAS stores values narrower than eight bytes in the low bytes of an
    // eight-byte slot, sign/zero extended for integer values and promoted to
    // f64 for float values.
    Ok(match primitive {
        ExtraBytesPrimitive::U8 | ExtraBytesPrimitive::U16 | ExtraBytesPrimitive::U32 => {
            ExtraBytesValue::Unsigned(read_u64(bytes, 40, "Extra Bytes NoData")?)
        }
        ExtraBytesPrimitive::I8 | ExtraBytesPrimitive::I16 | ExtraBytesPrimitive::I32 => {
            ExtraBytesValue::Signed(read_i64(bytes, 40, "Extra Bytes NoData")?)
        }
        ExtraBytesPrimitive::U64 => {
            ExtraBytesValue::Unsigned(read_u64(bytes, 40, "Extra Bytes NoData")?)
        }
        ExtraBytesPrimitive::I64 => {
            ExtraBytesValue::Signed(read_i64(bytes, 40, "Extra Bytes NoData")?)
        }
        ExtraBytesPrimitive::F32 | ExtraBytesPrimitive::F64 => {
            ExtraBytesValue::Float(read_f64(bytes, 40, "Extra Bytes NoData")?)
        }
    })
}

fn read_name(bytes: &[u8]) -> Result<String> {
    let name_bytes = &bytes[4..36];
    let end = name_bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(name_bytes.len());
    let name = std::str::from_utf8(&name_bytes[..end])
        .map_err(|_| invalid_descriptor("Extra Bytes name is not valid UTF-8"))?;
    if name.trim().is_empty() {
        return Err(invalid_descriptor("Extra Bytes name must not be empty"));
    }
    Ok(name.to_owned())
}

/// Parse LASF_Spec/4 Extra Bytes descriptors and validate their record layout.
pub fn parse_extra_bytes_descriptors(
    payloads: &[&[u8]],
    available_record_bytes: usize,
) -> Result<Vec<ExtraBytesDescriptor>> {
    let mut descriptors = Vec::new();
    let mut names = HashSet::new();
    let mut byte_offset = 0usize;

    for payload in payloads {
        if payload.is_empty() || payload.len() % EXTRA_BYTES_DESCRIPTOR_SIZE != 0 {
            return Err(invalid_descriptor(format!(
                "Extra Bytes VLR length {} is not a non-zero multiple of {EXTRA_BYTES_DESCRIPTOR_SIZE}",
                payload.len()
            )));
        }
        for record in payload.chunks_exact(EXTRA_BYTES_DESCRIPTOR_SIZE) {
            let name = read_name(record)?;
            if !names.insert(name.clone()) {
                return Err(invalid_descriptor(format!(
                    "Extra Bytes descriptor name {name:?} is duplicated"
                )));
            }

            let data_type = record[2];
            let options = record[3];
            let (primitive, element_count, length) = if data_type == 0 {
                if options == 0 {
                    return Err(invalid_descriptor(format!(
                        "untyped Extra Bytes descriptor {name:?} declares zero bytes"
                    )));
                }
                (None, 1, usize::from(options))
            } else if data_type <= 10 {
                let primitive = primitive_for_type(data_type)
                    .ok_or_else(|| invalid_descriptor("unknown Extra Bytes data type"))?;
                (Some(primitive), 1, primitive.byte_width())
            } else if (11..=30).contains(&data_type) {
                // LAS 1.4 R14 deprecated vector data types. Retain their
                // validated byte spans in metadata, but never decode them as
                // scalars.
                let element_count = if data_type <= 20 { 2 } else { 3 };
                let primitive_type = ((data_type - 1) % 10) + 1;
                let primitive = primitive_for_type(primitive_type)
                    .ok_or_else(|| invalid_descriptor("unknown Extra Bytes vector type"))?;
                let length = primitive
                    .byte_width()
                    .checked_mul(usize::from(element_count))
                    .ok_or_else(|| CopcError::new("overflow", "Extra Bytes length overflows"))?;
                (Some(primitive), element_count, length)
            } else {
                return Err(invalid_descriptor(format!(
                    "Extra Bytes descriptor {name:?} declares reserved data type {data_type}"
                )));
            };

            if options & 0xe0 != 0 && data_type != 0 {
                return Err(invalid_descriptor(format!(
                    "Extra Bytes descriptor {name:?} sets reserved option bits"
                )));
            }
            // For data type 0 the options byte is the field width, not a bit
            // field. Those descriptors are retained as opaque byte ranges.
            let scale = if data_type != 0 && options & (1 << 3) != 0 {
                let value = read_f64(record, 112, "Extra Bytes scale")?;
                Some(value)
            } else {
                None
            };
            let offset = if data_type != 0 && options & (1 << 4) != 0 {
                let value = read_f64(record, 136, "Extra Bytes offset")?;
                Some(value)
            } else {
                None
            };
            let no_data = if data_type != 0 && options & 1 != 0 {
                match primitive {
                    Some(primitive) => Some(read_no_data(record, primitive)?),
                    None => None,
                }
            } else {
                None
            };

            let next_offset = byte_offset
                .checked_add(length)
                .ok_or_else(|| CopcError::new("overflow", "Extra Bytes record offset overflows"))?;
            if next_offset > available_record_bytes {
                return Err(invalid_descriptor(format!(
                    "Extra Bytes descriptor {name:?} ends at byte {next_offset}, but the point record has only {available_record_bytes} extra bytes"
                )));
            }
            descriptors.push(ExtraBytesDescriptor {
                name,
                data_type,
                primitive,
                element_count,
                byte_offset,
                length,
                scale,
                offset,
                no_data,
            });
            byte_offset = next_offset;
        }
    }

    Ok(descriptors)
}

#[cfg(test)]
mod tests {
    use super::{EXTRA_BYTES_DESCRIPTOR_SIZE, parse_extra_bytes_descriptors};

    fn descriptor(name: &str, data_type: u8, options: u8) -> Vec<u8> {
        let mut bytes = vec![0; EXTRA_BYTES_DESCRIPTOR_SIZE];
        bytes[2] = data_type;
        bytes[3] = options;
        bytes[4..4 + name.len()].copy_from_slice(name.as_bytes());
        bytes
    }

    #[test]
    fn parses_scalar_types_and_record_offsets() {
        let first = descriptor("height", 6, 0);
        let second = descriptor("mission_id", 7, 0);
        let parsed = parse_extra_bytes_descriptors(&[&[first, second].concat()], 12).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].byte_offset, 0);
        assert_eq!(parsed[0].length, 4);
        assert_eq!(parsed[0].primitive.unwrap().metadata_type(), "signed");
        assert_eq!(parsed[1].byte_offset, 4);
        assert_eq!(parsed[1].length, 8);
    }

    #[test]
    fn rejects_malformed_names_lengths_and_duplicate_names() {
        assert_eq!(
            parse_extra_bytes_descriptors(&[&[0; 191]], 1)
                .unwrap_err()
                .code(),
            "malformed-extra-bytes"
        );
        let empty = descriptor("", 1, 0);
        assert_eq!(
            parse_extra_bytes_descriptors(&[&empty], 1)
                .unwrap_err()
                .code(),
            "malformed-extra-bytes"
        );
        let duplicate = [descriptor("same", 1, 0), descriptor("same", 1, 0)].concat();
        assert_eq!(
            parse_extra_bytes_descriptors(&[&duplicate], 2)
                .unwrap_err()
                .code(),
            "malformed-extra-bytes"
        );
    }

    #[test]
    fn retains_vector_and_untyped_descriptors_as_unsupported_layouts() {
        let vector = descriptor("vector", 29, 0);
        let untyped = descriptor("opaque", 0, 3);
        let parsed = parse_extra_bytes_descriptors(&[&[vector, untyped].concat()], 15).unwrap();
        assert_eq!(parsed[0].length, 12);
        assert!(!parsed[0].is_supported_scalar());
        assert_eq!(parsed[1].length, 3);
        assert!(parsed[1].primitive.is_none());
        assert_eq!(parsed[1].scale, None);
        assert_eq!(parsed[1].offset, None);
        assert_eq!(parsed[1].no_data, None);
    }
}
