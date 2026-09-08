use std::fmt::Display;

use copc_core::{CrsTransform, geographic_buffer_to_ecef};
use proj4wkt::wkt_to_projstring;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct FixtureMatrix {
    pub version: u32,
    pub fixtures: Vec<Fixture>,
}

#[derive(Debug, Deserialize)]
pub struct Fixture {
    pub id: String,
    pub source: String,
    pub wkt_family: String,
    pub wkt: String,
    pub horizontal_wkt: Option<String>,
    pub vertical_unit_scale: f64,
    pub points: Vec<SourcePoint>,
    pub tolerance: Tolerance,
}

#[derive(Debug, Deserialize)]
pub struct SourcePoint {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct GeographicPoint {
    pub longitude: f64,
    pub latitude: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Tolerance {
    pub longitude_degrees: f64,
    pub latitude_degrees: f64,
    pub height_meters: f64,
}

#[derive(Debug, Serialize)]
pub struct FixtureResult {
    pub id: String,
    pub full_wkt_proj_string: Option<String>,
    pub full_wkt_error: Option<String>,
    pub proj_string: Option<String>,
    pub points: Option<Vec<GeographicPoint>>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BenchmarkResult {
    pub fixture_id: String,
    pub point_count: usize,
    pub iterations: usize,
    pub initialization_micros: u128,
    pub crs_transform_micros: u128,
    pub ecef_transform_micros: u128,
    pub combined_transform_micros: u128,
    pub output_bytes: usize,
}

pub fn fixture_matrix() -> FixtureMatrix {
    serde_json::from_str(include_str!("fixtures.json")).expect("CRS audit fixture JSON is valid")
}

pub fn convert_wkt(wkt: &str) -> Result<String, String> {
    wkt_to_projstring(wkt).map_err(|error| format!("proj4wkt: {}", display_error(error)))
}

pub fn transform_fixture(fixture: &Fixture) -> Result<(String, Vec<GeographicPoint>), String> {
    let transform = CrsTransform::from_wkt(&fixture.wkt).map_err(|error| error.to_string())?;
    let source_coordinates = fixture
        .points
        .iter()
        .flat_map(|point| [point.x, point.y, point.z])
        .collect::<Vec<_>>();
    let geographic = transform
        .transform_buffer(&source_coordinates)
        .map_err(|error| error.to_string())?;
    let points = geographic
        .chunks_exact(3)
        .map(|values| GeographicPoint {
            longitude: values[0],
            latitude: values[1],
            height: values[2],
        })
        .collect();
    Ok((transform.source_proj_string().to_owned(), points))
}

pub fn evaluate_fixtures() -> Vec<FixtureResult> {
    fixture_matrix()
        .fixtures
        .iter()
        .map(|fixture| {
            let (full_wkt_proj_string, full_wkt_error) = match convert_wkt(&fixture.wkt) {
                Ok(proj_string) => (Some(proj_string), None),
                Err(error) => (None, Some(error)),
            };
            match transform_fixture(fixture) {
                Ok((proj_string, points)) => FixtureResult {
                    id: fixture.id.clone(),
                    full_wkt_proj_string,
                    full_wkt_error,
                    proj_string: Some(proj_string),
                    points: Some(points),
                    error: None,
                },
                Err(error) => FixtureResult {
                    id: fixture.id.clone(),
                    full_wkt_proj_string,
                    full_wkt_error,
                    proj_string: None,
                    points: None,
                    error: Some(error),
                },
            }
        })
        .collect()
}

pub fn benchmark_fixture(
    fixture_id: &str,
    point_count: usize,
    iterations: usize,
) -> Result<BenchmarkResult, String> {
    if point_count == 0 || iterations == 0 {
        return Err("point_count and iterations must be positive".to_owned());
    }

    let fixture = fixture_matrix()
        .fixtures
        .into_iter()
        .find(|fixture| fixture.id == fixture_id)
        .ok_or_else(|| format!("unknown CRS audit fixture: {fixture_id}"))?;

    let coordinates = repeated_coordinates(&fixture.points, point_count);
    let initialization_start = std::time::Instant::now();
    let transform = CrsTransform::from_wkt(&fixture.wkt).map_err(|error| error.to_string())?;
    let initialization_micros = initialization_start.elapsed().as_micros();

    let crs_start = std::time::Instant::now();
    let mut geographic = Vec::new();
    for _ in 0..iterations {
        geographic = transform
            .transform_buffer(&coordinates)
            .map_err(|error| error.to_string())?;
    }
    let crs_transform_micros = crs_start.elapsed().as_micros();

    let ecef_start = std::time::Instant::now();
    let mut ecef = Vec::new();
    for _ in 0..iterations {
        ecef = geographic_buffer_to_ecef(&geographic).map_err(|error| error.to_string())?;
    }
    let ecef_transform_micros = ecef_start.elapsed().as_micros();
    std::hint::black_box(&geographic);
    std::hint::black_box(&ecef);

    let combined_start = std::time::Instant::now();
    let mut combined_output_bytes = 0;
    for _ in 0..iterations {
        let combined = transform
            .transform_buffer_to_ecef(&coordinates)
            .map_err(|error| error.to_string())?;
        combined_output_bytes = combined.geographic.len() * std::mem::size_of::<f64>()
            + combined.ecef.len() * std::mem::size_of::<f64>();
        std::hint::black_box(&combined);
    }
    let combined_transform_micros = combined_start.elapsed().as_micros();

    Ok(BenchmarkResult {
        fixture_id: fixture.id,
        point_count,
        iterations,
        initialization_micros,
        crs_transform_micros,
        ecef_transform_micros,
        combined_transform_micros,
        output_bytes: combined_output_bytes,
    })
}

fn repeated_coordinates(points: &[SourcePoint], point_count: usize) -> Vec<f64> {
    points
        .iter()
        .cycle()
        .take(point_count)
        .flat_map(|point| [point.x, point.y, point.z])
        .collect()
}

fn display_error(error: impl Display) -> String {
    error.to_string()
}

#[cfg(target_arch = "wasm32")]
mod wasm_api {
    use super::{CrsTransform, fixture_matrix};
    use js_sys::Float64Array;
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    pub struct CrsAuditTransformer {
        transform: CrsTransform,
    }

    #[wasm_bindgen]
    impl CrsAuditTransformer {
        #[wasm_bindgen(constructor)]
        pub fn new(fixture_id: &str) -> Result<CrsAuditTransformer, JsValue> {
            let fixture = fixture_matrix()
                .fixtures
                .into_iter()
                .find(|fixture| fixture.id == fixture_id)
                .ok_or_else(|| JsValue::from_str("unknown CRS audit fixture"))?;
            let transform = CrsTransform::from_wkt(&fixture.wkt)
                .map_err(|error| JsValue::from_str(error.message()))?;
            Ok(Self { transform })
        }

        pub fn transform_points(
            &self,
            coordinates: &Float64Array,
        ) -> Result<Float64Array, JsValue> {
            let mut input = vec![0.0; coordinates.length() as usize];
            coordinates.copy_to(&mut input);
            let output = self
                .transform
                .transform_buffer(&input)
                .map_err(|error| JsValue::from_str(error.message()))?;
            Ok(Float64Array::from(output.as_slice()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{fixture_matrix, transform_fixture};
    use copc_core::CrsTransform;

    #[test]
    fn fixture_matrix_contains_real_and_boundary_cases() {
        let matrix = fixture_matrix();
        assert_eq!(matrix.version, 1);
        assert!(
            matrix
                .fixtures
                .iter()
                .any(|fixture| fixture.id.starts_with("autzen"))
        );
        assert!(
            matrix
                .fixtures
                .iter()
                .any(|fixture| fixture.id.starts_with("sofi"))
        );
        assert!(
            matrix
                .fixtures
                .iter()
                .any(|fixture| fixture.wkt_family == "WKT1 GEOGCS")
        );
        assert!(
            matrix
                .fixtures
                .iter()
                .any(|fixture| fixture.wkt_family == "WKT2 PROJCRS")
        );
    }

    #[test]
    fn supported_fixtures_produce_finite_multiple_points() {
        let matrix = fixture_matrix();
        for fixture in &matrix.fixtures {
            let (_, points) = transform_fixture(fixture).expect("fixture should be transformable");
            assert_eq!(points.len(), fixture.points.len());
            assert!(points.iter().all(|point| {
                [point.longitude, point.latitude, point.height]
                    .iter()
                    .all(|value| value.is_finite())
            }));
        }
    }

    #[test]
    fn sofi_full_compound_gap_stays_visible_beside_supported_horizontal_path() {
        let fixture = fixture_matrix()
            .fixtures
            .into_iter()
            .find(|fixture| fixture.id == "sofi-wkt1-compound-utm11")
            .expect("SoFi fixture");
        assert!(super::convert_wkt(&fixture.wkt).is_err());
        let transform = CrsTransform::from_wkt(&fixture.wkt).expect("horizontal fallback");
        assert!(transform.used_horizontal_fallback());
    }
}
