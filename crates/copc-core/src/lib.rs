#![cfg_attr(
    not(test),
    deny(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::todo,
        clippy::unimplemented
    )
)]

mod binary;
mod crs;
mod decoder;
mod error;
mod header;
mod hierarchy;
mod interleave;
mod vlr;

pub use crs::{
    CrsTransform, EcefPoint, GeographicPoint, PreparedCoordinates, geographic_buffer_to_ecef,
    geographic_to_ecef,
};
pub use decoder::{
    DecodedCopcNode, FIELD_CLASSIFICATION, FIELD_INTENSITY, FIELD_RGB, decode_copc_node,
};
pub use error::{CopcError, Result};
pub use header::{CopcHeader, parse_header};
pub use hierarchy::{RootHierarchy, RootHierarchyNode, RootHierarchyPage, parse_root_hierarchy};
pub use interleave::interleave_xyz;
