use crate::binary::{read_i32, read_i64};
use crate::error::{CopcError, Result};

const HIERARCHY_ENTRY_SIZE: usize = 32;
const MAX_HIERARCHY_PAGE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootHierarchyNode {
    pub level: i32,
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub point_data_offset: u64,
    pub point_data_length: u32,
    pub point_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootHierarchyPage {
    pub level: i32,
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub page_offset: u64,
    pub page_length: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootHierarchy {
    pub entry_count: usize,
    pub nodes: Vec<RootHierarchyNode>,
    pub pages: Vec<RootHierarchyPage>,
}

fn validate_key(level: i32, x: i32, y: i32, z: i32) -> Result<()> {
    if !(0..=31).contains(&level) || x < 0 || y < 0 || z < 0 {
        return Err(CopcError::new(
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
        return Err(CopcError::new(
            "invalid-hierarchy",
            "hierarchy voxel coordinate exceeds its level",
        ));
    }
    Ok(())
}

pub fn parse_root_hierarchy(bytes: &[u8]) -> Result<RootHierarchy> {
    if bytes.len() > MAX_HIERARCHY_PAGE_BYTES {
        return Err(CopcError::new(
            "unsupported-value",
            format!("root hierarchy page exceeds {MAX_HIERARCHY_PAGE_BYTES} bytes"),
        ));
    }
    if bytes.is_empty() || !bytes.len().is_multiple_of(HIERARCHY_ENTRY_SIZE) {
        return Err(CopcError::new(
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
            return Err(CopcError::new(
                "invalid-hierarchy",
                "hierarchy offsets and lengths cannot be negative",
            ));
        }
        let offset = offset as u64;
        offset
            .checked_add(byte_size as u64)
            .ok_or_else(|| CopcError::new("overflow", "hierarchy byte range overflows"))?;
        if point_count == -1 {
            if byte_size == 0 {
                return Err(CopcError::new(
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
            return Err(CopcError::new(
                "invalid-hierarchy",
                "unsupported negative hierarchy point count",
            ));
        }
    }

    Ok(RootHierarchy {
        entry_count,
        nodes,
        pages,
    })
}

#[cfg(test)]
mod tests {
    use super::parse_root_hierarchy;

    fn put_i32(bytes: &mut [u8], offset: usize, value: i32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn put_i64(bytes: &mut [u8], offset: usize, value: i64) {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    #[test]
    fn parses_root_nodes_and_page_references() {
        let mut bytes = vec![0; 64];
        put_i32(&mut bytes, 0, 0);
        put_i64(&mut bytes, 16, 100);
        put_i32(&mut bytes, 24, 32);
        put_i32(&mut bytes, 28, 12);
        put_i32(&mut bytes, 32, 1);
        put_i32(&mut bytes, 36, 0);
        put_i32(&mut bytes, 40, 0);
        put_i64(&mut bytes, 48, 200);
        put_i32(&mut bytes, 56, 64);
        put_i32(&mut bytes, 60, -1);

        let result = parse_root_hierarchy(&bytes).expect("fixture should parse");
        assert_eq!(result.entry_count, 2);
        assert_eq!(result.nodes.len(), 1);
        assert_eq!(result.pages.len(), 1);
        assert_eq!(result.pages[0].page_offset, 200);
    }

    #[test]
    fn rejects_malformed_hierarchy_values() {
        assert_eq!(
            parse_root_hierarchy(&[]).unwrap_err().code(),
            "invalid-hierarchy"
        );
        assert_eq!(
            parse_root_hierarchy(&[0; 31]).unwrap_err().code(),
            "invalid-hierarchy"
        );

        let mut invalid_key = vec![0; 32];
        put_i32(&mut invalid_key, 0, 1);
        put_i32(&mut invalid_key, 4, 2);
        assert_eq!(
            parse_root_hierarchy(&invalid_key).unwrap_err().code(),
            "invalid-hierarchy"
        );

        let mut invalid_count = vec![0; 32];
        put_i32(&mut invalid_count, 28, -2);
        assert_eq!(
            parse_root_hierarchy(&invalid_count).unwrap_err().code(),
            "invalid-hierarchy"
        );

        let mut invalid_page = vec![0; 32];
        put_i32(&mut invalid_page, 28, -1);
        assert_eq!(
            parse_root_hierarchy(&invalid_page).unwrap_err().code(),
            "invalid-hierarchy"
        );
    }

    #[test]
    fn rejects_large_pages() {
        let large = vec![0; 64 * 1024 * 1024 + 32];
        assert_eq!(
            parse_root_hierarchy(&large).unwrap_err().code(),
            "unsupported-value"
        );
    }
}
