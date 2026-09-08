use crate::crs::{CrsTransform, geographic_to_ecef};
use crate::decoder::{CopcNodeDecoder, DecodedCopcNode};
use crate::error::{CopcError, Result};

#[derive(Debug, Clone, PartialEq)]
pub struct PreparedPointRange {
    pub min: f64,
    pub max: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PreparedPointStatistics {
    pub elevation: Option<PreparedPointRange>,
    pub intensity: Option<PreparedPointRange>,
    pub rgb_max: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PreparedCopcNode {
    pub point_count: usize,
    pub source_coordinates: Vec<f64>,
    pub geographic_coordinates: Vec<f64>,
    pub ecef_coordinates: Vec<f64>,
    pub intensity: Option<Vec<u16>>,
    pub classification: Option<Vec<u8>>,
    pub red: Option<Vec<u16>>,
    pub green: Option<Vec<u16>>,
    pub blue: Option<Vec<u16>>,
    pub statistics: PreparedPointStatistics,
}

/// Dataset-scoped point preparation state.
///
/// LAS/LAZ metadata and CRS parsing happen when this value is initialized.
/// Individual node jobs then only provide their compressed chunk and reuse
/// both validated decoder metadata and projection state.
pub struct CopcNodePreparer {
    decoder: CopcNodeDecoder,
    transform: CrsTransform,
}

impl CopcNodePreparer {
    pub fn from_metadata(metadata: &[u8]) -> Result<Self> {
        let decoder = CopcNodeDecoder::from_metadata(metadata)?;
        let header = decoder.header();
        let transform = CrsTransform::from_wkt_or_geographic(
            header.wkt.as_deref(),
            [
                header.bounds[0],
                header.bounds[1],
                header.bounds[3],
                header.bounds[4],
            ],
        )?;
        Ok(Self { decoder, transform })
    }

    pub fn transform(&self) -> &CrsTransform {
        &self.transform
    }

    pub fn decode_node(
        &self,
        chunk: &[u8],
        point_count: usize,
        requested_fields: u32,
    ) -> Result<DecodedCopcNode> {
        self.decoder.decode(chunk, point_count, requested_fields)
    }

    /// Prepare one decoded node with one traversal for transforms and
    /// point-level reductions.
    pub fn prepare_decoded(&self, decoded: DecodedCopcNode) -> Result<PreparedCopcNode> {
        let coordinate_length = decoded
            .point_count
            .checked_mul(3)
            .ok_or_else(|| CopcError::new("overflow", "coordinate output length overflows"))?;
        if decoded.coordinates.len() != coordinate_length {
            return Err(CopcError::new(
                "chunk-length-mismatch",
                "decoded coordinate buffer does not match point count",
            ));
        }

        let mut geographic_coordinates = Vec::new();
        geographic_coordinates
            .try_reserve_exact(coordinate_length)
            .map_err(|_| {
                CopcError::new(
                    "allocation",
                    "unable to allocate geographic coordinate buffer",
                )
            })?;
        let mut ecef_coordinates = Vec::new();
        ecef_coordinates
            .try_reserve_exact(coordinate_length)
            .map_err(|_| {
                CopcError::new("allocation", "unable to allocate ECEF coordinate buffer")
            })?;
        let mut elevation = None;
        let mut intensity = None;
        let mut rgb_value_max = None;

        for (index, values) in decoded.coordinates.chunks_exact(3).enumerate() {
            let geographic = self
                .transform
                .transform_point([values[0], values[1], values[2]])?;
            let ecef = geographic_to_ecef(geographic)?;
            geographic_coordinates.extend([
                geographic.longitude,
                geographic.latitude,
                geographic.height,
            ]);
            ecef_coordinates.extend([ecef.x, ecef.y, ecef.z]);

            update_range(&mut elevation, geographic.height);
            if let Some(values) = decoded.intensity.as_ref() {
                update_range(&mut intensity, f64::from(values[index]));
            }
            if let (Some(red), Some(green), Some(blue)) = (
                decoded.red.as_ref(),
                decoded.green.as_ref(),
                decoded.blue.as_ref(),
            ) {
                let point_max = u32::from(red[index])
                    .max(u32::from(green[index]))
                    .max(u32::from(blue[index]));
                rgb_value_max = Some(rgb_value_max.unwrap_or(0).max(point_max));
            }
        }

        Ok(PreparedCopcNode {
            point_count: decoded.point_count,
            source_coordinates: decoded.coordinates,
            geographic_coordinates,
            ecef_coordinates,
            intensity: decoded.intensity,
            classification: decoded.classification,
            red: decoded.red,
            green: decoded.green,
            blue: decoded.blue,
            statistics: PreparedPointStatistics {
                elevation,
                intensity,
                rgb_max: rgb_value_max.map(|max| if max <= 255 { 255 } else { 65535 }),
            },
        })
    }

    pub fn prepare_node(
        &self,
        chunk: &[u8],
        point_count: usize,
        requested_fields: u32,
    ) -> Result<PreparedCopcNode> {
        self.prepare_decoded(self.decode_node(chunk, point_count, requested_fields)?)
    }
}

fn update_range(range: &mut Option<PreparedPointRange>, value: f64) {
    match range {
        Some(current) => {
            current.min = current.min.min(value);
            current.max = current.max.max(value);
        }
        None => {
            *range = Some(PreparedPointRange {
                min: value,
                max: value,
            });
        }
    }
}
