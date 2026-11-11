use std::io::Cursor;

use laz::las::selective::DecompressionSelection;
use laz::record::{LayeredPointRecordDecompressor, RecordDecompressor};
use laz::{LazItemType, LazVlr};

use crate::binary::{read_array, read_i32, read_i64, read_u16, read_u32, read_u64};
use crate::error::{CopcError, Result};
use crate::extra_bytes::{ExtraBytesDescriptor, ExtraBytesPrimitive, ExtraBytesValue};
use crate::header::{CopcHeader, parse_header};
use crate::vlr::{VlrVisit, for_each_vlr};

pub const FIELD_INTENSITY: u32 = 1 << 0;
pub const FIELD_CLASSIFICATION: u32 = 1 << 1;
pub const FIELD_RGB: u32 = 1 << 2;

const KNOWN_FIELD_MASK: u32 = FIELD_INTENSITY | FIELD_CLASSIFICATION | FIELD_RGB;
const MAX_DECODE_POINTS: usize = 5_000_000;
const MAX_DECODED_NODE_BYTES: usize = MAX_DECODE_POINTS * 38;
const MAX_EXTRA_DIMENSION_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
pub const DEFAULT_MAX_NODE_CHUNK_BYTES: usize = 64 * 1024 * 1024;

fn allocate_zeroed<T>(length: usize, what: &str) -> Result<Vec<T>>
where
    T: Clone + Default,
{
    let mut values = Vec::new();
    values
        .try_reserve_exact(length)
        .map_err(|_| CopcError::new("allocation", format!("unable to allocate {what} buffer")))?;
    values.resize(length, T::default());
    Ok(values)
}

fn base_record_length(point_format: u8) -> Result<usize> {
    match point_format {
        6 => Ok(30),
        7 => Ok(36),
        8 => Ok(38),
        _ => Err(CopcError::new(
            "unsupported-point-format",
            "LAS point format is outside the initial COPC decoder scope",
        )),
    }
}

fn select_extra_dimensions<'a>(
    descriptors: &'a [ExtraBytesDescriptor],
    requested: &[String],
    point_count: usize,
) -> Result<Vec<&'a ExtraBytesDescriptor>> {
    let mut selected = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for name in requested {
        if !seen.insert(name) {
            continue;
        }
        let descriptor = descriptors
            .iter()
            .find(|descriptor| descriptor.name == *name)
            .ok_or_else(|| {
                CopcError::new(
                    "invalid-value",
                    format!("COPC Extra Bytes dimension is not available: {name}"),
                )
            })?;
        if !descriptor.is_supported_scalar() {
            return Err(CopcError::new(
                "unsupported-value",
                format!("COPC Extra Bytes dimension {name:?} is not a supported scalar field"),
            ));
        }
        selected.push(descriptor);
    }

    let output_bytes = selected
        .len()
        .checked_mul(point_count)
        .and_then(|count| count.checked_mul(std::mem::size_of::<u64>()))
        .ok_or_else(|| CopcError::new("overflow", "Extra Bytes output size overflows"))?;
    if output_bytes > MAX_EXTRA_DIMENSION_OUTPUT_BYTES {
        return Err(CopcError::new(
            "unsupported-value",
            format!(
                "Extra Bytes output exceeds the {MAX_EXTRA_DIMENSION_OUTPUT_BYTES}-byte safety limit"
            ),
        ));
    }
    Ok(selected)
}

fn allocate_extra_dimension_values(
    descriptor: &ExtraBytesDescriptor,
    point_count: usize,
) -> Result<DecodedExtraDimensionValues> {
    match descriptor.primitive {
        Some(ExtraBytesPrimitive::U64)
            if descriptor.scale.unwrap_or(1.0) == 1.0
                && descriptor.offset.unwrap_or(0.0) == 0.0 =>
        {
            Ok(DecodedExtraDimensionValues::Uint64(allocate_zeroed(
                point_count,
                "unsigned 64-bit Extra Bytes",
            )?))
        }
        Some(ExtraBytesPrimitive::I64)
            if descriptor.scale.unwrap_or(1.0) == 1.0
                && descriptor.offset.unwrap_or(0.0) == 0.0 =>
        {
            Ok(DecodedExtraDimensionValues::Int64(allocate_zeroed(
                point_count,
                "signed 64-bit Extra Bytes",
            )?))
        }
        Some(_) => Ok(DecodedExtraDimensionValues::Float64(allocate_zeroed(
            point_count,
            "numeric Extra Bytes",
        )?)),
        None => Err(CopcError::new(
            "unsupported-value",
            "untyped Extra Bytes cannot be decoded as a numeric field",
        )),
    }
}

fn read_extra_value(
    record: &[u8],
    offset: usize,
    descriptor: &ExtraBytesDescriptor,
) -> Result<ExtraBytesValue> {
    let value = match descriptor.primitive {
        Some(ExtraBytesPrimitive::U8) => ExtraBytesValue::Unsigned(u64::from(
            read_array::<1>(record, offset, "Extra Bytes")?[0],
        )),
        Some(ExtraBytesPrimitive::I8) => ExtraBytesValue::Signed(i64::from(
            read_array::<1>(record, offset, "Extra Bytes")?[0] as i8,
        )),
        Some(ExtraBytesPrimitive::U16) => {
            ExtraBytesValue::Unsigned(u64::from(read_u16(record, offset, "Extra Bytes")?))
        }
        Some(ExtraBytesPrimitive::I16) => {
            let bytes = read_array::<2>(record, offset, "Extra Bytes")?;
            ExtraBytesValue::Signed(i64::from(i16::from_le_bytes(bytes)))
        }
        Some(ExtraBytesPrimitive::U32) => {
            ExtraBytesValue::Unsigned(u64::from(read_u32(record, offset, "Extra Bytes")?))
        }
        Some(ExtraBytesPrimitive::I32) => {
            ExtraBytesValue::Signed(i64::from(read_i32(record, offset, "Extra Bytes")?))
        }
        Some(ExtraBytesPrimitive::U64) => {
            ExtraBytesValue::Unsigned(read_u64(record, offset, "Extra Bytes")?)
        }
        Some(ExtraBytesPrimitive::I64) => {
            ExtraBytesValue::Signed(read_i64(record, offset, "Extra Bytes")?)
        }
        Some(ExtraBytesPrimitive::F32) => {
            let bytes = read_array::<4>(record, offset, "Extra Bytes")?;
            ExtraBytesValue::Float(f64::from(f32::from_le_bytes(bytes)))
        }
        Some(ExtraBytesPrimitive::F64) => {
            let bytes = read_array::<8>(record, offset, "Extra Bytes")?;
            ExtraBytesValue::Float(f64::from_le_bytes(bytes))
        }
        None => {
            return Err(CopcError::new(
                "unsupported-value",
                "untyped Extra Bytes cannot be decoded as a numeric field",
            ));
        }
    };
    Ok(value)
}

fn apply_extra_dimension_semantics(
    descriptor: &ExtraBytesDescriptor,
    value: ExtraBytesValue,
) -> Result<DecodedExtraDimensionValue> {
    if descriptor.scale.unwrap_or(1.0) == 1.0 && descriptor.offset.unwrap_or(0.0) == 0.0 {
        match value {
            ExtraBytesValue::Unsigned(value)
                if descriptor.primitive == Some(ExtraBytesPrimitive::U64) =>
            {
                return Ok(DecodedExtraDimensionValue::Uint64(value));
            }
            ExtraBytesValue::Signed(value)
                if descriptor.primitive == Some(ExtraBytesPrimitive::I64) =>
            {
                return Ok(DecodedExtraDimensionValue::Int64(value));
            }
            _ => {}
        }
    }
    let raw_value = match value {
        ExtraBytesValue::Unsigned(value) => value as f64,
        ExtraBytesValue::Signed(value) => value as f64,
        ExtraBytesValue::Float(value) => value,
    };
    let scaled = raw_value * descriptor.scale.unwrap_or(1.0) + descriptor.offset.unwrap_or(0.0);
    Ok(DecodedExtraDimensionValue::Float64(scaled))
}

#[derive(Debug, Clone, PartialEq)]
pub struct DecodedCopcNode {
    pub point_count: usize,
    pub coordinates: Vec<f64>,
    pub intensity: Option<Vec<u16>>,
    pub classification: Option<Vec<u8>>,
    pub red: Option<Vec<u16>>,
    pub green: Option<Vec<u16>>,
    pub blue: Option<Vec<u16>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DecodedExtraDimensionValues {
    Float64(Vec<f64>),
    Int64(Vec<i64>),
    Uint64(Vec<u64>),
}

impl DecodedExtraDimensionValues {
    fn set(&mut self, index: usize, value: DecodedExtraDimensionValue) -> Result<()> {
        match (self, value) {
            (Self::Float64(values), DecodedExtraDimensionValue::Float64(value)) => {
                *values.get_mut(index).ok_or_else(|| {
                    CopcError::new("truncated", "Extra Bytes output index is out of range")
                })? = value;
            }
            (Self::Int64(values), DecodedExtraDimensionValue::Int64(value)) => {
                *values.get_mut(index).ok_or_else(|| {
                    CopcError::new("truncated", "Extra Bytes output index is out of range")
                })? = value;
            }
            (Self::Uint64(values), DecodedExtraDimensionValue::Uint64(value)) => {
                *values.get_mut(index).ok_or_else(|| {
                    CopcError::new("truncated", "Extra Bytes output index is out of range")
                })? = value;
            }
            _ => {
                return Err(CopcError::new(
                    "invalid-value",
                    "Extra Bytes output type does not match its descriptor",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum DecodedExtraDimensionValue {
    Float64(f64),
    Int64(i64),
    Uint64(u64),
}

#[derive(Debug, Clone, PartialEq)]
pub struct DecodedExtraDimension {
    pub name: String,
    pub values: DecodedExtraDimensionValues,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DecodedCopcNodeWithExtraDimensions {
    pub node: DecodedCopcNode,
    pub extra_dimensions: Vec<DecodedExtraDimension>,
}

/// A validated decoder initialized from one dataset's LAS/LAZ metadata.
///
/// The header and LASZIP VLR are intentionally retained so node jobs do not
/// repeatedly parse the complete metadata buffer.
pub struct CopcNodeDecoder {
    header: CopcHeader,
    extra_dimensions: Vec<ExtraBytesDescriptor>,
    laz_vlr: LazVlr,
    max_node_chunk_bytes: usize,
}

fn parse_laz_vlr(bytes: &[u8], header: &CopcHeader) -> Result<LazVlr> {
    let header_size = read_u16(bytes, 94, "header size")? as usize;
    let point_data_offset = read_u32(bytes, 96, "point data offset")? as usize;
    let number_of_vlrs = read_u32(bytes, 100, "number of VLRs")? as usize;
    if bytes.get(104).is_none_or(|format| format & 0x80 == 0) {
        return Err(CopcError::new(
            "unsupported-value",
            "COPC node data is not marked as compressed LAZ",
        ));
    }

    let base_record_length = match header.point_data_record_format {
        6 => 30,
        7 => 36,
        8 => 38,
        format => {
            return Err(CopcError::new(
                "unsupported-point-format",
                format!("LAS point format {format} is outside the initial COPC decoder scope"),
            ));
        }
    };
    if usize::from(header.point_data_record_length) < base_record_length {
        return Err(CopcError::new(
            "unsupported-point-format",
            format!(
                "LAS point format {} requires at least {base_record_length} bytes per record, found {}",
                header.point_data_record_format, header.point_data_record_length,
            ),
        ));
    }

    let mut laz_vlr = None;
    for_each_vlr(
        bytes,
        header_size,
        point_data_offset,
        number_of_vlrs,
        "LAZ VLR payload offset overflows the input",
        |user_id, record_id, payload| {
            if user_id == LazVlr::USER_ID && record_id == LazVlr::RECORD_ID {
                laz_vlr = Some(
                    LazVlr::from_buffer(payload)
                        .map_err(|value| CopcError::new("invalid-laz-vlr", value.to_string()))?,
                );
                return Ok(VlrVisit::Stop);
            }
            Ok(VlrVisit::Continue)
        },
    )?;

    laz_vlr.ok_or_else(|| {
        CopcError::new(
            "missing-laz-vlr",
            "LASZIP VLR is required to decode a COPC node",
        )
    })
}

fn validate_laz_layout(laz_vlr: &LazVlr, header: &CopcHeader) -> Result<()> {
    let record_length = laz_vlr.items().iter().try_fold(0usize, |length, item| {
        length
            .checked_add(usize::from(item.size()))
            .ok_or_else(|| CopcError::new("overflow", "LAZ record length overflows"))
    })?;
    let declared_record_length = usize::from(header.point_data_record_length);
    if record_length != declared_record_length {
        return Err(CopcError::new(
            "invalid-laz-vlr",
            format!(
                "LASZIP record length {record_length} does not match LAS record length {declared_record_length}"
            ),
        ));
    }

    let (base_items, base_sizes): (&[LazItemType], &[usize]) = match header.point_data_record_format
    {
        6 => (&[LazItemType::Point14], &[30]),
        7 => (&[LazItemType::Point14, LazItemType::RGB14], &[30, 6]),
        8 => (&[LazItemType::Point14, LazItemType::RGBNIR14], &[30, 8]),
        _ => {
            return Err(CopcError::new(
                "unsupported-point-format",
                "LAS point format is outside the initial COPC decoder scope",
            ));
        }
    };
    let base_record_length = base_sizes.iter().sum::<usize>();
    let extra_bytes = declared_record_length
        .checked_sub(base_record_length)
        .ok_or_else(|| {
            CopcError::new(
                "invalid-laz-vlr",
                "LAS point record is shorter than its format-defined fields",
            )
        })?;
    let expected_item_count = base_items.len() + usize::from(extra_bytes > 0);
    if laz_vlr.items().len() != expected_item_count {
        return Err(CopcError::new(
            "invalid-laz-vlr",
            "LASZIP item layout does not match the LAS point format",
        ));
    }
    for (item, (expected_type, expected_size)) in laz_vlr
        .items()
        .iter()
        .zip(base_items.iter().zip(base_sizes))
    {
        if item.item_type() != *expected_type
            || usize::from(item.size()) != *expected_size
            || !matches!(item.version(), 3 | 4)
        {
            return Err(CopcError::new(
                "invalid-laz-vlr",
                "LASZIP item layout does not match the LAS point format",
            ));
        }
    }
    if extra_bytes > 0 {
        let extra_bytes_u16 = u16::try_from(extra_bytes)
            .map_err(|_| CopcError::new("overflow", "LAS extra-byte length exceeds u16"))?;
        let item = laz_vlr.items().last().ok_or_else(|| {
            CopcError::new(
                "invalid-laz-vlr",
                "LASZIP extra-byte item is missing from the declared record layout",
            )
        })?;
        if item.item_type() != LazItemType::Byte14(extra_bytes_u16)
            || usize::from(item.size()) != extra_bytes
            || !matches!(item.version(), 3 | 4)
        {
            return Err(CopcError::new(
                "invalid-laz-vlr",
                "LASZIP extra-byte item does not match the LAS point record length",
            ));
        }
    }
    Ok(())
}

impl CopcNodeDecoder {
    pub fn from_metadata(metadata: &[u8]) -> Result<Self> {
        Self::from_metadata_with_max_chunk_bytes(metadata, DEFAULT_MAX_NODE_CHUNK_BYTES)
    }

    pub fn from_metadata_with_max_chunk_bytes(
        metadata: &[u8],
        max_node_chunk_bytes: usize,
    ) -> Result<Self> {
        if max_node_chunk_bytes == 0 {
            return Err(CopcError::new(
                "invalid-value",
                "COPC node chunk byte limit must be positive",
            ));
        }
        let header = parse_header(metadata)?;
        let laz_vlr = parse_laz_vlr(metadata, &header)?;
        validate_laz_layout(&laz_vlr, &header)?;

        Ok(Self {
            extra_dimensions: header.extra_dimensions.clone(),
            header,
            laz_vlr,
            max_node_chunk_bytes,
        })
    }

    pub fn header(&self) -> &CopcHeader {
        &self.header
    }

    pub fn decode(
        &self,
        chunk: &[u8],
        point_count: usize,
        requested_fields: u32,
    ) -> Result<DecodedCopcNode> {
        Ok(self
            .decode_with_extra_dimensions(chunk, point_count, requested_fields, &[])?
            .node)
    }

    pub fn decode_with_extra_dimensions(
        &self,
        chunk: &[u8],
        point_count: usize,
        requested_fields: u32,
        requested_extra_dimensions: &[String],
    ) -> Result<DecodedCopcNodeWithExtraDimensions> {
        if requested_fields & !KNOWN_FIELD_MASK != 0 {
            return Err(CopcError::new(
                "unsupported-value",
                "unknown COPC point field selection bits",
            ));
        }
        if point_count == 0 {
            return Err(CopcError::new(
                "invalid-value",
                "COPC node point count must be positive",
            ));
        }
        if point_count > MAX_DECODE_POINTS {
            return Err(CopcError::new(
                "unsupported-value",
                format!("COPC node has more than the {MAX_DECODE_POINTS}-point safety limit"),
            ));
        }
        if chunk.len() > self.max_node_chunk_bytes {
            return Err(CopcError::new(
                "unsupported-value",
                format!(
                    "COPC node chunk exceeds the {}-byte safety limit",
                    self.max_node_chunk_bytes
                ),
            ));
        }
        let header = &self.header;
        let laz_vlr = &self.laz_vlr;
        let record_length = usize::from(header.point_data_record_length);
        let minimum_chunk_length = record_length
            .checked_add(4)
            .ok_or_else(|| CopcError::new("overflow", "COPC node chunk length overflows"))?;
        if chunk.len() < minimum_chunk_length {
            return Err(CopcError::new(
                "truncated",
                "COPC node chunk is shorter than its first point and count",
            ));
        }

        let compressed_count_offset = record_length;
        let compressed_count =
            read_u32(chunk, compressed_count_offset, "COPC chunk point count")? as usize;
        if compressed_count != point_count {
            return Err(CopcError::new(
                "chunk-length-mismatch",
                format!("hierarchy says {point_count} points but chunk says {compressed_count}"),
            ));
        }
        let raw_length = point_count.checked_mul(record_length).ok_or_else(|| {
            CopcError::new("overflow", "decompressed point buffer size overflows")
        })?;
        if raw_length > MAX_DECODED_NODE_BYTES {
            return Err(CopcError::new(
                "unsupported-value",
                format!(
                    "decompressed point buffer exceeds the {MAX_DECODED_NODE_BYTES}-byte safety limit"
                ),
            ));
        }
        let has_intensity = requested_fields & FIELD_INTENSITY != 0;
        let has_classification = requested_fields & FIELD_CLASSIFICATION != 0;
        let has_rgb = requested_fields & FIELD_RGB != 0 && header.point_data_record_format >= 7;
        let selected_extra_dimensions = select_extra_dimensions(
            &self.extra_dimensions,
            requested_extra_dimensions,
            point_count,
        )?;
        let mut selection = DecompressionSelection::xy_returns_channel().decompress_z();
        if has_intensity {
            selection = selection.decompress_intensity();
        }
        if has_classification {
            selection = selection.decompress_classification();
        }
        if has_rgb {
            selection = selection.decompress_rgb();
        }
        if !selected_extra_dimensions.is_empty() {
            selection = selection.decompress_extra_bytes();
        }

        let mut decompressor = LayeredPointRecordDecompressor::new(Cursor::new(chunk));
        decompressor
            .set_fields_from(laz_vlr.items())
            .map_err(|value| CopcError::new("laz-decode", value.to_string()))?;
        if decompressor.record_size() != record_length {
            return Err(CopcError::new(
                "invalid-laz-vlr",
                format!(
                    "LASZIP decoder record length {} does not match LAS record length {record_length}",
                    decompressor.record_size()
                ),
            ));
        }
        decompressor.set_selection(selection);

        let mut raw = Vec::new();
        raw.try_reserve_exact(raw_length).map_err(|_| {
            CopcError::new("allocation", "unable to allocate decompressed point buffer")
        })?;
        raw.resize(raw_length, 0);
        decompressor
            .decompress_many(&mut raw)
            .map_err(|value| CopcError::new("laz-decode", value.to_string()))?;
        let consumed = usize::try_from(decompressor.get().position()).map_err(|_| {
            CopcError::new(
                "overflow",
                "LAZ decoder position does not fit in this target",
            )
        })?;
        if consumed != chunk.len() {
            return Err(CopcError::new(
                "chunk-length-mismatch",
                format!(
                    "LAZ decoder consumed {consumed} bytes from a {}-byte node chunk",
                    chunk.len()
                ),
            ));
        }

        let coordinate_length = point_count
            .checked_mul(3)
            .ok_or_else(|| CopcError::new("overflow", "coordinate buffer size overflows"))?;
        let mut coordinates = allocate_zeroed(coordinate_length, "coordinate")?;
        let mut intensity = if has_intensity {
            Some(allocate_zeroed(point_count, "intensity")?)
        } else {
            None
        };
        let mut classification = if has_classification {
            Some(allocate_zeroed(point_count, "classification")?)
        } else {
            None
        };
        let mut red = if has_rgb {
            Some(allocate_zeroed(point_count, "red")?)
        } else {
            None
        };
        let mut green = if has_rgb {
            Some(allocate_zeroed(point_count, "green")?)
        } else {
            None
        };
        let mut blue = if has_rgb {
            Some(allocate_zeroed(point_count, "blue")?)
        } else {
            None
        };
        let mut extra_dimensions = selected_extra_dimensions
            .iter()
            .map(|descriptor| {
                Ok(DecodedExtraDimension {
                    name: descriptor.name.clone(),
                    values: allocate_extra_dimension_values(descriptor, point_count)?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let base_record_length = base_record_length(header.point_data_record_format)?;

        for index in 0..point_count {
            let record_start = index
                .checked_mul(record_length)
                .ok_or_else(|| CopcError::new("overflow", "point record offset overflows"))?;
            let record_end = record_start
                .checked_add(record_length)
                .ok_or_else(|| CopcError::new("overflow", "point record range overflows"))?;
            let record = raw.get(record_start..record_end).ok_or_else(|| {
                CopcError::new(
                    "truncated",
                    format!("point record {index} exceeds the decoded point buffer"),
                )
            })?;
            let x = f64::from(read_i32(record, 0, "point X")?);
            let y = f64::from(read_i32(record, 4, "point Y")?);
            let z = f64::from(read_i32(record, 8, "point Z")?);
            let coordinate_offset = index
                .checked_mul(3)
                .ok_or_else(|| CopcError::new("overflow", "coordinate offset overflows"))?;
            let coordinate_end = coordinate_offset
                .checked_add(3)
                .ok_or_else(|| CopcError::new("overflow", "coordinate range overflows"))?;
            let coordinate_values = coordinates
                .get_mut(coordinate_offset..coordinate_end)
                .ok_or_else(|| {
                    CopcError::new(
                        "truncated",
                        format!("point {index} exceeds the coordinate buffer"),
                    )
                })?;
            coordinate_values.copy_from_slice(&[
                x * header.scale[0] + header.offset[0],
                y * header.scale[1] + header.offset[1],
                z * header.scale[2] + header.offset[2],
            ]);
            if let Some(values) = intensity.as_deref_mut() {
                let value = values.get_mut(index).ok_or_else(|| {
                    CopcError::new("truncated", format!("point {index} exceeds intensity data"))
                })?;
                *value = read_u16(record, 12, "point intensity")?;
            }
            if let Some(values) = classification.as_deref_mut() {
                let value = values.get_mut(index).ok_or_else(|| {
                    CopcError::new(
                        "truncated",
                        format!("point {index} exceeds classification data"),
                    )
                })?;
                *value = record.get(16).copied().ok_or_else(|| {
                    CopcError::new("truncated", "point classification field is unavailable")
                })?;
            }
            if has_rgb {
                if let Some(values) = red.as_deref_mut() {
                    let value = values.get_mut(index).ok_or_else(|| {
                        CopcError::new("truncated", format!("point {index} exceeds red data"))
                    })?;
                    *value = read_u16(record, 30, "point red")?;
                }
                if let Some(values) = green.as_deref_mut() {
                    let value = values.get_mut(index).ok_or_else(|| {
                        CopcError::new("truncated", format!("point {index} exceeds green data"))
                    })?;
                    *value = read_u16(record, 32, "point green")?;
                }
                if let Some(values) = blue.as_deref_mut() {
                    let value = values.get_mut(index).ok_or_else(|| {
                        CopcError::new("truncated", format!("point {index} exceeds blue data"))
                    })?;
                    *value = read_u16(record, 34, "point blue")?;
                }
            }
            for (descriptor, dimension) in selected_extra_dimensions
                .iter()
                .zip(extra_dimensions.iter_mut())
            {
                let field_offset = base_record_length
                    .checked_add(descriptor.byte_offset)
                    .ok_or_else(|| {
                        CopcError::new("overflow", "Extra Bytes field offset overflows")
                    })?;
                let raw_value = read_extra_value(record, field_offset, descriptor)?;
                dimension.values.set(
                    index,
                    apply_extra_dimension_semantics(descriptor, raw_value)?,
                )?;
            }
        }

        Ok(DecodedCopcNodeWithExtraDimensions {
            node: DecodedCopcNode {
                point_count,
                coordinates,
                intensity,
                classification,
                red,
                green,
                blue,
            },
            extra_dimensions,
        })
    }
}

pub fn decode_copc_node(
    metadata: &[u8],
    chunk: &[u8],
    point_count: usize,
    requested_fields: u32,
) -> Result<DecodedCopcNode> {
    CopcNodeDecoder::from_metadata(metadata)?.decode(chunk, point_count, requested_fields)
}

pub fn decode_copc_node_with_max_chunk_bytes(
    metadata: &[u8],
    chunk: &[u8],
    point_count: usize,
    requested_fields: u32,
    max_node_chunk_bytes: usize,
) -> Result<DecodedCopcNode> {
    CopcNodeDecoder::from_metadata_with_max_chunk_bytes(metadata, max_node_chunk_bytes)?.decode(
        chunk,
        point_count,
        requested_fields,
    )
}

pub fn decode_copc_node_with_extra_dimensions(
    metadata: &[u8],
    chunk: &[u8],
    point_count: usize,
    requested_fields: u32,
    requested_extra_dimensions: &[String],
    max_node_chunk_bytes: usize,
) -> Result<DecodedCopcNodeWithExtraDimensions> {
    CopcNodeDecoder::from_metadata_with_max_chunk_bytes(metadata, max_node_chunk_bytes)?
        .decode_with_extra_dimensions(
            chunk,
            point_count,
            requested_fields,
            requested_extra_dimensions,
        )
}

#[cfg(test)]
mod tests {
    use laz::record::{LayeredPointRecordCompressor, RecordCompressor};
    use laz::{LazVlr, LazVlrBuilder};

    use crate::CopcNodePreparer;

    use super::{
        DecodedCopcNode, FIELD_CLASSIFICATION, FIELD_INTENSITY, FIELD_RGB, decode_copc_node,
        decode_copc_node_with_max_chunk_bytes,
    };

    fn put_u16(bytes: &mut [u8], offset: usize, value: u16) {
        bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn put_i32(bytes: &mut [u8], offset: usize, value: i32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn put_i64(bytes: &mut [u8], offset: usize, value: i64) {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u64(bytes: &mut [u8], offset: usize, value: u64) {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    fn put_f64(bytes: &mut [u8], offset: usize, value: f64) {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    fn put_f32(bytes: &mut [u8], offset: usize, value: f32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn put_vlr(
        bytes: &mut [u8],
        offset: usize,
        user_id: &str,
        record_id: u16,
        payload: &[u8],
    ) -> usize {
        bytes[offset + 2..offset + 2 + user_id.len()].copy_from_slice(user_id.as_bytes());
        put_u16(bytes, offset + 18, record_id);
        put_u16(bytes, offset + 20, payload.len() as u16);
        bytes[offset + 54..offset + 54 + payload.len()].copy_from_slice(payload);
        offset + 54 + payload.len()
    }

    fn compressed_fixture() -> (Vec<u8>, Vec<u8>) {
        compressed_fixture_with_extra(7, 0)
    }

    fn compressed_fixture_with_extra(point_format: u8, extra_bytes: u16) -> (Vec<u8>, Vec<u8>) {
        compressed_fixture_with_extra_data(point_format, extra_bytes, &[])
    }

    fn compressed_fixture_with_extra_data(
        point_format: u8,
        extra_bytes: u16,
        extra_data: &[Vec<u8>],
    ) -> (Vec<u8>, Vec<u8>) {
        let base_record_length = match point_format {
            6 => 30,
            7 => 36,
            8 => 38,
            _ => unreachable!("test fixture uses a supported point format"),
        };
        let record_length = base_record_length + usize::from(extra_bytes);
        let laz_vlr = LazVlrBuilder::default()
            .with_point_format(point_format, extra_bytes)
            .unwrap()
            .with_variable_chunk_size()
            .build();
        let mut laz_payload = Vec::new();
        laz_vlr.write_to(&mut laz_payload).unwrap();

        let header_size = 375;
        let wkt = br#"GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]"#;
        let point_data_offset = header_size + 54 + 160 + 54 + wkt.len() + 54 + laz_payload.len();
        let mut metadata = vec![0; point_data_offset];
        metadata[0..4].copy_from_slice(b"LASF");
        metadata[24] = 1;
        metadata[25] = 4;
        put_u16(&mut metadata, 94, header_size as u16);
        put_u32(&mut metadata, 96, point_data_offset as u32);
        put_u32(&mut metadata, 100, 3);
        metadata[104] = point_format | 0x80;
        put_u16(&mut metadata, 105, record_length as u16);
        put_u64(&mut metadata, 247, 2);
        put_f64(&mut metadata, 131, 0.01);
        put_f64(&mut metadata, 139, 0.02);
        put_f64(&mut metadata, 147, 0.03);
        put_f64(&mut metadata, 155, 10.0);
        put_f64(&mut metadata, 163, 20.0);
        put_f64(&mut metadata, 171, 30.0);
        put_f64(&mut metadata, 179, 100.0);
        put_f64(&mut metadata, 187, 1.0);
        put_f64(&mut metadata, 195, 200.0);
        put_f64(&mut metadata, 203, 2.0);
        put_f64(&mut metadata, 211, 300.0);
        put_f64(&mut metadata, 219, 3.0);

        let mut copc_payload = vec![0; 160];
        put_f64(&mut copc_payload, 0, 50.0);
        put_f64(&mut copc_payload, 8, 60.0);
        put_f64(&mut copc_payload, 16, 70.0);
        put_f64(&mut copc_payload, 24, 10.0);
        put_f64(&mut copc_payload, 32, 2.5);
        put_u64(&mut copc_payload, 40, point_data_offset as u64 + 32);
        put_u64(&mut copc_payload, 48, 64);
        let copc_end = put_vlr(&mut metadata, header_size, "copc", 1, &copc_payload);
        let wkt_end = put_vlr(&mut metadata, copc_end, "LASF_Projection", 2112, wkt);
        put_vlr(
            &mut metadata,
            wkt_end,
            LazVlr::USER_ID,
            LazVlr::RECORD_ID,
            &laz_payload,
        );

        let mut raw = vec![0; record_length * 2];
        for (index, (x, y, z, intensity, classification, rgb)) in [
            (100, 200, 300, 400, 5, [600, 700, 800]),
            (101, 201, 301, 401, 6, [601, 701, 801]),
        ]
        .into_iter()
        .enumerate()
        {
            let record = &mut raw[index * record_length..(index + 1) * record_length];
            put_i32(record, 0, x);
            put_i32(record, 4, y);
            put_i32(record, 8, z);
            put_u16(record, 12, intensity);
            record[16] = classification;
            if point_format >= 7 {
                put_u16(record, 30, rgb[0]);
                put_u16(record, 32, rgb[1]);
                put_u16(record, 34, rgb[2]);
            }
            for (extra_index, value) in record[base_record_length..].iter_mut().enumerate() {
                *value = (index * 17 + extra_index) as u8;
            }
            if let Some(values) = extra_data.get(index) {
                assert_eq!(values.len(), usize::from(extra_bytes));
                record[base_record_length..].copy_from_slice(values);
            }
        }
        let mut compressor = LayeredPointRecordCompressor::new(Vec::new());
        compressor.set_fields_from(laz_vlr.items()).unwrap();
        compressor.compress_many(&raw).unwrap();
        compressor.done().unwrap();
        (metadata, compressor.into_inner())
    }

    fn extra_bytes_descriptor(name: &str, data_type: u8, options: u8) -> Vec<u8> {
        let mut descriptor = vec![0; 192];
        descriptor[2] = data_type;
        descriptor[3] = options;
        descriptor[4..4 + name.len()].copy_from_slice(name.as_bytes());
        descriptor
    }

    fn append_extra_bytes_vlr(mut metadata: Vec<u8>, descriptors: &[u8]) -> Vec<u8> {
        let offset = metadata.len();
        let mut vlr = vec![0; 54 + descriptors.len()];
        vlr[2..2 + b"LASF_Spec".len()].copy_from_slice(b"LASF_Spec");
        put_u16(&mut vlr, 18, 4);
        put_u16(&mut vlr, 20, descriptors.len() as u16);
        vlr[54..].copy_from_slice(descriptors);
        metadata.extend_from_slice(&vlr);
        put_u32(&mut metadata, 96, (offset + vlr.len()) as u32);
        let count = u32::from_le_bytes(metadata[100..104].try_into().unwrap()) + 1;
        put_u32(&mut metadata, 100, count);
        metadata
    }

    #[test]
    fn decodes_supported_point_format_and_requested_attributes_natively() {
        let (metadata, chunk) = compressed_fixture();
        let result = decode_copc_node(
            &metadata,
            &chunk,
            2,
            FIELD_INTENSITY | FIELD_CLASSIFICATION | FIELD_RGB,
        )
        .expect("compressed fixture should decode");
        assert_eq!(result.coordinates, [11.0, 24.0, 39.0, 11.01, 24.02, 39.03]);
        assert_eq!(result.intensity.as_deref(), Some(&[400, 401][..]));
        assert_eq!(result.classification.as_deref(), Some(&[5, 6][..]));
        assert_eq!(result.red.as_deref(), Some(&[600, 601][..]));
        assert_eq!(result.green.as_deref(), Some(&[700, 701][..]));
        assert_eq!(result.blue.as_deref(), Some(&[800, 801][..]));

        let selected = decode_copc_node(&metadata, &chunk, 2, FIELD_CLASSIFICATION)
            .expect("selective decode should succeed");
        assert_eq!(selected.classification.as_deref(), Some(&[5, 6][..]));
        assert!(selected.intensity.is_none());
        assert!(selected.red.is_none());
    }

    #[test]
    fn decodes_standard_fields_with_extra_bytes_for_point_formats_6_7_and_8() {
        for (point_format, expected_rgb) in [(6, false), (7, true), (8, true)] {
            let (metadata, chunk) = compressed_fixture_with_extra(point_format, 4);
            let result = decode_copc_node(
                &metadata,
                &chunk,
                2,
                FIELD_INTENSITY | FIELD_CLASSIFICATION | FIELD_RGB,
            )
            .expect("valid extra-byte records should decode");

            assert_eq!(result.coordinates, [11.0, 24.0, 39.0, 11.01, 24.02, 39.03]);
            assert_eq!(result.intensity.as_deref(), Some(&[400, 401][..]));
            assert_eq!(result.classification.as_deref(), Some(&[5, 6][..]));
            assert_eq!(result.red.is_some(), expected_rgb);
            assert_eq!(result.green.is_some(), expected_rgb);
            assert_eq!(result.blue.is_some(), expected_rgb);
            if expected_rgb {
                assert_eq!(result.red.as_deref(), Some(&[600, 601][..]));
                assert_eq!(result.green.as_deref(), Some(&[700, 701][..]));
                assert_eq!(result.blue.as_deref(), Some(&[800, 801][..]));
            }
        }
    }

    #[test]
    fn selectively_decodes_scalar_extra_bytes_and_preserves_64_bit_integers() {
        use super::{DecodedExtraDimensionValues, decode_copc_node_with_extra_dimensions};
        use crate::parse_header;

        let mut raw_first = vec![0; 44];
        let mut raw_second = vec![0; 44];
        for (raw, index) in [(&mut raw_first, 0usize), (&mut raw_second, 1usize)] {
            raw[0] = if index == 0 { 255 } else { 128 };
            raw[1] = (-2i8 + index as i8) as u8;
            raw[2..4].copy_from_slice(&(1000u16 + index as u16 * 1000).to_le_bytes());
            raw[4..6].copy_from_slice(&(-1000i16 - index as i16 * 1000).to_le_bytes());
            raw[6..10].copy_from_slice(&(100_000u32 + index as u32 * 100_000).to_le_bytes());
            raw[10..14].copy_from_slice(&(-100_000i32 - index as i32 * 100_000).to_le_bytes());
            put_u64(raw, 14, 9_007_199_254_740_993 + index as u64);
            put_i64(raw, 22, -9_007_199_254_740_995 + index as i64);
            put_f32(raw, 30, 1.5 + index as f32);
            put_f64(raw, 34, 2.5 + index as f64);
            raw[42..44].copy_from_slice(&(200u16 + index as u16 * 100).to_le_bytes());
        }
        let extras = vec![raw_first, raw_second];
        let (metadata, chunk) = compressed_fixture_with_extra_data(8, 44, &extras);
        let mut descriptors = Vec::new();
        for (name, data_type, options) in [
            ("u8", 1, 0),
            ("i8", 2, 0),
            ("u16", 3, 0),
            ("i16", 4, 0),
            ("u32", 5, 0),
            ("i32", 6, 0),
            ("u64", 7, 0),
            ("i64", 8, 0),
            ("f32", 9, 0),
            ("f64", 10, 0),
            ("scaled", 3, 25),
        ] {
            let mut descriptor = extra_bytes_descriptor(name, data_type, options);
            if name == "scaled" {
                put_u64(&mut descriptor, 40, 10);
                put_f64(&mut descriptor, 112, 0.5);
                put_f64(&mut descriptor, 136, 4.0);
            }
            descriptors.extend_from_slice(&descriptor);
        }
        let metadata = append_extra_bytes_vlr(metadata, &descriptors);
        let names = [
            "u8", "i8", "u16", "i16", "u32", "i32", "u64", "i64", "f32", "f64", "scaled",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
        let decoded = decode_copc_node_with_extra_dimensions(
            &metadata,
            &chunk,
            2,
            0,
            &names,
            64 * 1024 * 1024,
        )
        .expect("all declared scalar fields should decode");
        let values = decoded
            .extra_dimensions
            .iter()
            .map(|dimension| (dimension.name.as_str(), &dimension.values))
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            values["u8"],
            &DecodedExtraDimensionValues::Float64(vec![255.0, 128.0])
        );
        assert_eq!(
            values["i8"],
            &DecodedExtraDimensionValues::Float64(vec![-2.0, -1.0])
        );
        assert_eq!(
            values["u16"],
            &DecodedExtraDimensionValues::Float64(vec![1000.0, 2000.0])
        );
        assert_eq!(
            values["i16"],
            &DecodedExtraDimensionValues::Float64(vec![-1000.0, -2000.0])
        );
        assert_eq!(
            values["u32"],
            &DecodedExtraDimensionValues::Float64(vec![100_000.0, 200_000.0])
        );
        assert_eq!(
            values["i32"],
            &DecodedExtraDimensionValues::Float64(vec![-100_000.0, -200_000.0])
        );
        assert_eq!(
            values["u64"],
            &DecodedExtraDimensionValues::Uint64(vec![
                9_007_199_254_740_993,
                9_007_199_254_740_994
            ]),
        );
        assert_eq!(
            values["i64"],
            &DecodedExtraDimensionValues::Int64(vec![
                -9_007_199_254_740_995,
                -9_007_199_254_740_994
            ]),
        );
        assert_eq!(
            values["f32"],
            &DecodedExtraDimensionValues::Float64(vec![1.5, 2.5])
        );
        assert_eq!(
            values["f64"],
            &DecodedExtraDimensionValues::Float64(vec![2.5, 3.5])
        );
        assert_eq!(
            values["scaled"],
            &DecodedExtraDimensionValues::Float64(vec![104.0, 154.0])
        );
        assert_eq!(
            parse_header(&metadata).unwrap().extra_dimensions[10].decoded_no_data(),
            Some(9.0)
        );

        let duplicate_request = vec!["u8".to_owned(), "u8".to_owned()];
        let selected = decode_copc_node_with_extra_dimensions(
            &metadata,
            &chunk,
            2,
            0,
            &duplicate_request,
            64 * 1024 * 1024,
        )
        .expect("duplicate requests collapse");
        assert_eq!(selected.extra_dimensions.len(), 1);
        assert_eq!(selected.extra_dimensions[0].name, "u8");
        assert_eq!(
            decode_copc_node_with_extra_dimensions(
                &metadata,
                &chunk,
                2,
                0,
                &["missing".to_owned()],
                64 * 1024 * 1024,
            )
            .unwrap_err()
            .code(),
            "invalid-value"
        );
    }

    #[test]
    fn decodes_named_extra_bytes_for_point_formats_6_7_and_8() {
        use super::{DecodedExtraDimensionValues, decode_copc_node_with_extra_dimensions};

        for point_format in [6, 7, 8] {
            let (metadata, chunk) = compressed_fixture_with_extra(point_format, 1);
            let descriptor = extra_bytes_descriptor("echo", 1, 0);
            let metadata = append_extra_bytes_vlr(metadata, &descriptor);
            let decoded = decode_copc_node_with_extra_dimensions(
                &metadata,
                &chunk,
                2,
                0,
                &["echo".to_owned()],
                64 * 1024 * 1024,
            )
            .expect("supported point format should decode named Extra Bytes");
            assert_eq!(
                decoded.extra_dimensions[0].values,
                DecodedExtraDimensionValues::Float64(vec![0.0, 17.0]),
            );
        }
    }

    #[test]
    fn explicitly_rejects_vector_and_untyped_extra_byte_values() {
        use super::decode_copc_node_with_extra_dimensions;

        let (metadata, chunk) = compressed_fixture_with_extra(6, 12);
        let metadata = append_extra_bytes_vlr(metadata, &extra_bytes_descriptor("vector", 29, 0));
        assert_eq!(
            decode_copc_node_with_extra_dimensions(
                &metadata,
                &chunk,
                2,
                0,
                &["vector".to_owned()],
                64 * 1024 * 1024,
            )
            .unwrap_err()
            .code(),
            "unsupported-value"
        );

        let (metadata, chunk) = compressed_fixture_with_extra(6, 3);
        let metadata = append_extra_bytes_vlr(metadata, &extra_bytes_descriptor("opaque", 0, 3));
        assert_eq!(
            decode_copc_node_with_extra_dimensions(
                &metadata,
                &chunk,
                2,
                0,
                &["opaque".to_owned()],
                64 * 1024 * 1024,
            )
            .unwrap_err()
            .code(),
            "unsupported-value"
        );
    }

    #[test]
    fn validates_extra_byte_record_lengths_and_bounds_decompression() {
        let (mut metadata, _) = compressed_fixture_with_extra(6, 4);
        put_u16(&mut metadata, 105, 29);
        assert_eq!(
            decode_copc_node(&metadata, &[], 1, 0).unwrap_err().code(),
            "unsupported-point-format"
        );

        let (mut metadata, _) = compressed_fixture_with_extra(6, 4);
        put_u16(&mut metadata, 105, 33);
        assert_eq!(
            decode_copc_node(&metadata, &[], 1, 0).unwrap_err().code(),
            "invalid-laz-vlr"
        );

        let (mut metadata, _) = compressed_fixture();
        metadata[104] = 6 | 0x80;
        assert_eq!(
            decode_copc_node(&metadata, &[], 1, 0).unwrap_err().code(),
            "invalid-laz-vlr"
        );

        let (metadata, _) = compressed_fixture_with_extra(6, u16::MAX - 30);
        let mut chunk = vec![0; usize::from(u16::MAX) + 4];
        put_u32(&mut chunk, usize::from(u16::MAX), 5_000_000);
        assert_eq!(
            decode_copc_node(&metadata, &chunk, 5_000_000, 0)
                .unwrap_err()
                .code(),
            "unsupported-value"
        );
    }

    #[test]
    fn prepares_coordinates_and_statistics_in_one_dataset_scoped_path() {
        let (metadata, chunk) = compressed_fixture();
        let preparer = CopcNodePreparer::from_metadata(&metadata)
            .expect("fixture metadata should initialize the node preparer");
        let prepared = preparer
            .prepare_node(
                &chunk,
                2,
                FIELD_INTENSITY | FIELD_CLASSIFICATION | FIELD_RGB,
            )
            .expect("fixture node should be prepared");

        assert_eq!(prepared.point_count, 2);
        assert_eq!(prepared.source_coordinates[0..4], [11.0, 24.0, 39.0, 11.01]);
        assert!((prepared.source_coordinates[4] - 24.02).abs() < 1e-12);
        assert_eq!(prepared.source_coordinates[5], 39.03);
        for (geographic, source) in prepared
            .geographic_coordinates
            .iter()
            .zip(prepared.source_coordinates.iter())
        {
            assert!((geographic - source).abs() < 1e-12);
        }
        assert!(
            prepared
                .ecef_coordinates
                .iter()
                .all(|value| value.is_finite())
        );
        assert_eq!(prepared.statistics.elevation.as_ref().unwrap().min, 39.0);
        assert_eq!(prepared.statistics.elevation.as_ref().unwrap().max, 39.03);
        assert_eq!(prepared.statistics.intensity.as_ref().unwrap().min, 400.0);
        assert_eq!(prepared.statistics.intensity.as_ref().unwrap().max, 401.0);
        assert_eq!(prepared.statistics.rgb_max, Some(65535));
    }

    #[test]
    fn rejects_decode_limits_and_malformed_chunks() {
        let (metadata, chunk) = compressed_fixture();
        assert_eq!(
            decode_copc_node(&metadata, &chunk, 0, 0)
                .unwrap_err()
                .code(),
            "invalid-value"
        );
        assert_eq!(
            decode_copc_node(&metadata, &chunk, 5_000_001, 0)
                .unwrap_err()
                .code(),
            "unsupported-value"
        );
        assert_eq!(
            decode_copc_node(&metadata, &chunk, 2, 8)
                .unwrap_err()
                .code(),
            "unsupported-value"
        );

        let mut mismatched = chunk.clone();
        put_u32(&mut mismatched, 36, 1);
        assert_eq!(
            decode_copc_node(&metadata, &mismatched, 2, 0)
                .unwrap_err()
                .code(),
            "chunk-length-mismatch"
        );

        let truncated = &chunk[..chunk.len() - 1];
        let outcome = std::panic::catch_unwind(|| decode_copc_node(&metadata, truncated, 2, 0));
        assert!(outcome.is_ok());
        assert!(outcome.unwrap().is_err());

        let preparer = CopcNodePreparer::from_metadata(&metadata).unwrap();
        let malformed = DecodedCopcNode {
            point_count: 1,
            coordinates: vec![0.0, 0.0, 0.0],
            intensity: Some(Vec::new()),
            classification: None,
            red: None,
            green: None,
            blue: None,
        };
        assert_eq!(
            preparer.prepare_decoded(malformed).unwrap_err().code(),
            "chunk-length-mismatch"
        );
    }

    #[test]
    fn applies_the_caller_supplied_node_chunk_limit() {
        let (metadata, chunk) = compressed_fixture();
        assert_eq!(
            decode_copc_node_with_max_chunk_bytes(&metadata, &chunk, 2, 0, 1)
                .unwrap_err()
                .code(),
            "unsupported-value"
        );
        assert_eq!(
            decode_copc_node_with_max_chunk_bytes(&metadata, &chunk, 2, 0, chunk.len())
                .expect("chunk is within supplied limit")
                .point_count,
            2
        );
    }
}
