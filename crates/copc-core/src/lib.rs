mod binary;
mod decoder;
mod error;
mod header;
mod hierarchy;
mod interleave;
mod vlr;

pub use decoder::{
    DecodedCopcNode, FIELD_CLASSIFICATION, FIELD_INTENSITY, FIELD_RGB, decode_copc_node,
};
pub use error::{CopcError, Result};
pub use header::{CopcHeader, parse_header};
pub use hierarchy::{RootHierarchy, RootHierarchyNode, RootHierarchyPage, parse_root_hierarchy};
pub use interleave::interleave_xyz;
