use serde::Serialize;

use crate::binary::{read_i32, read_i64, safe_u64};
use crate::error::{ParseError, error};

const HIERARCHY_ENTRY_SIZE: usize = 32;
const MAX_HIERARCHY_PAGE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub(crate) struct RootHierarchyNode {
    level: i32,
    x: i32,
    y: i32,
    z: i32,
    point_data_offset: u64,
    point_data_length: u32,
    point_count: u32,
}

#[derive(Debug, Serialize)]
pub(crate) struct RootHierarchyPage {
    level: i32,
    x: i32,
    y: i32,
    z: i32,
    page_offset: u64,
    page_length: u32,
}

#[derive(Debug, Serialize)]
pub(crate) struct RootHierarchyResult {
    entry_count: usize,
    pub(crate) nodes: Vec<RootHierarchyNode>,
    pub(crate) pages: Vec<RootHierarchyPage>,
}

fn validate_key(level: i32, x: i32, y: i32, z: i32) -> Result<(), ParseError> {
    if !(0..=31).contains(&level) || x < 0 || y < 0 || z < 0 {
        return Err(error(
            "invalid-hierarchy",
            "hierarchy voxel key is outside supported bounds",
        ));
    }
    let maximum = if level == 31 {
        i64::from(i32::MAX)
    } else {
        (1_i64 << level) - 1
    };
    if i64::from(x) > maximum || i64::from(y) > maximum || i64::from(z) > maximum {
        return Err(error(
            "invalid-hierarchy",
            "hierarchy voxel coordinate exceeds its level",
        ));
    }
    Ok(())
}

pub(crate) fn parse_root_hierarchy(bytes: &[u8]) -> Result<RootHierarchyResult, ParseError> {
    if bytes.len() > MAX_HIERARCHY_PAGE_BYTES {
        return Err(error(
            "unsupported-value",
            format!("root hierarchy page exceeds {MAX_HIERARCHY_PAGE_BYTES} bytes"),
        ));
    }
    if bytes.is_empty() || !bytes.len().is_multiple_of(HIERARCHY_ENTRY_SIZE) {
        return Err(error(
            "invalid-hierarchy",
            format!(
                "root hierarchy length {} is not aligned to {HIERARCHY_ENTRY_SIZE}",
                bytes.len()
            ),
        ));
    }

    let entry_count = bytes.len() / HIERARCHY_ENTRY_SIZE;
    let mut nodes = Vec::with_capacity(entry_count);
    let mut pages = Vec::new();
    for index in 0..entry_count {
        let start = index * HIERARCHY_ENTRY_SIZE;
        let level = read_i32(bytes, start, "hierarchy level")?;
        let x = read_i32(bytes, start + 4, "hierarchy X")?;
        let y = read_i32(bytes, start + 8, "hierarchy Y")?;
        let z = read_i32(bytes, start + 12, "hierarchy Z")?;
        validate_key(level, x, y, z)?;
        let offset = read_i64(bytes, start + 16, "hierarchy byte offset")?;
        let byte_size = read_i32(bytes, start + 24, "hierarchy byte size")?;
        let point_count = read_i32(bytes, start + 28, "hierarchy point count")?;
        if offset < 0 || byte_size < 0 {
            return Err(error(
                "invalid-hierarchy",
                "hierarchy offsets and lengths cannot be negative",
            ));
        }
        let offset = safe_u64(offset as u64, "hierarchy byte offset")?;
        let end = offset
            .checked_add(byte_size as u32 as u64)
            .ok_or_else(|| error("overflow", "hierarchy byte range overflows"))?;
        safe_u64(end, "hierarchy byte range end")?;
        if point_count == -1 {
            if byte_size == 0 {
                return Err(error(
                    "invalid-hierarchy",
                    "hierarchy page length must be positive",
                ));
            }
            pages.push(RootHierarchyPage {
                level,
                x,
                y,
                z,
                page_offset: offset,
                page_length: byte_size as u32,
            });
        } else if point_count >= 0 {
            nodes.push(RootHierarchyNode {
                level,
                x,
                y,
                z,
                point_data_offset: offset,
                point_data_length: byte_size as u32,
                point_count: point_count as u32,
            });
        } else {
            return Err(error(
                "invalid-hierarchy",
                "unsupported negative hierarchy point count",
            ));
        }
    }

    Ok(RootHierarchyResult {
        entry_count,
        nodes,
        pages,
    })
}
