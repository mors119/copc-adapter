use std::fmt::Display;

use proj4rs::proj::Proj;
use proj4rs::transform::transform;
use proj4wkt::wkt_to_projstring;
use serde::{Deserialize, Serialize};

const WGS84_PROJ: &str = "+proj=longlat +datum=WGS84 +no_defs";

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
    pub transform_micros: u128,
    pub output_bytes: usize,
}

pub fn fixture_matrix() -> FixtureMatrix {
    serde_json::from_str(include_str!("fixtures.json")).expect("CRS audit fixture JSON is valid")
}

pub fn convert_wkt(wkt: &str) -> Result<String, String> {
    wkt_to_projstring(wkt).map_err(|error| format!("proj4wkt: {}", display_error(error)))
}

pub fn transform_fixture(fixture: &Fixture) -> Result<(String, Vec<GeographicPoint>), String> {
    let source_wkt = fixture.horizontal_wkt.as_deref().unwrap_or(&fixture.wkt);
    let proj_string = convert_wkt(source_wkt)?;
    let from = Proj::from_proj_string(&proj_string).map_err(|error| {
        format!(
            "proj4rs source parse: {} ({proj_string})",
            display_error(error)
        )
    })?;
    let to = Proj::from_proj_string(WGS84_PROJ)
        .map_err(|error| format!("proj4rs WGS84 parse: {}", display_error(error)))?;
    let source_is_geographic = proj_string.contains("+proj=longlat");
    let points = transform_points(
        &from,
        &to,
        &fixture.points,
        fixture.vertical_unit_scale,
        source_is_geographic,
    )?;
    Ok((proj_string, points))
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
    let source_wkt = fixture.horizontal_wkt.as_deref().unwrap_or(&fixture.wkt);
    let proj_string = convert_wkt(source_wkt)?;
    let from = Proj::from_proj_string(&proj_string).map_err(display_error)?;
    let to = Proj::from_proj_string(WGS84_PROJ).map_err(display_error)?;
    let source_is_geographic = proj_string.contains("+proj=longlat");
    let initialization_micros = initialization_start.elapsed().as_micros();

    let transform_start = std::time::Instant::now();
    let mut output = Vec::new();
    for _ in 0..iterations {
        output = transform_flat_coordinates(
            &from,
            &to,
            &coordinates,
            fixture.vertical_unit_scale,
            source_is_geographic,
        )?;
    }
    let transform_micros = transform_start.elapsed().as_micros();

    Ok(BenchmarkResult {
        fixture_id: fixture.id,
        point_count,
        iterations,
        initialization_micros,
        transform_micros,
        output_bytes: output.len() * std::mem::size_of::<f64>(),
    })
}

fn transform_points(
    from: &Proj,
    to: &Proj,
    points: &[SourcePoint],
    vertical_unit_scale: f64,
    source_is_geographic: bool,
) -> Result<Vec<GeographicPoint>, String> {
    points
        .iter()
        .map(|point| {
            transform_one(
                from,
                to,
                point.x,
                point.y,
                point.z,
                vertical_unit_scale,
                source_is_geographic,
            )
        })
        .collect()
}

fn transform_flat_coordinates(
    from: &Proj,
    to: &Proj,
    coordinates: &[f64],
    vertical_unit_scale: f64,
    source_is_geographic: bool,
) -> Result<Vec<f64>, String> {
    if !coordinates.len().is_multiple_of(3) {
        return Err("coordinate buffer must contain XYZ triples".to_owned());
    }

    let mut output = Vec::with_capacity(coordinates.len());
    for values in coordinates.chunks_exact(3) {
        let point = transform_one(
            from,
            to,
            values[0],
            values[1],
            values[2],
            vertical_unit_scale,
            source_is_geographic,
        )?;
        output.extend([point.longitude, point.latitude, point.height]);
    }
    Ok(output)
}

fn transform_one(
    from: &Proj,
    to: &Proj,
    x: f64,
    y: f64,
    z: f64,
    vertical_unit_scale: f64,
    source_is_geographic: bool,
) -> Result<GeographicPoint, String> {
    let mut transformed = if source_is_geographic {
        (x.to_radians(), y.to_radians(), 0.0)
    } else {
        (x, y, 0.0)
    };
    transform(from, to, &mut transformed).map_err(display_error)?;
    let point = GeographicPoint {
        longitude: transformed.0.to_degrees(),
        latitude: transformed.1.to_degrees(),
        height: z * vertical_unit_scale,
    };
    if [point.longitude, point.latitude, point.height]
        .iter()
        .all(|value| value.is_finite())
    {
        Ok(point)
    } else {
        Err(format!("non-finite candidate result for ({x}, {y}, {z})"))
    }
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
    use super::{WGS84_PROJ, fixture_matrix, transform_flat_coordinates};
    use js_sys::Float64Array;
    use proj4rs::proj::Proj;
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    pub struct CrsAuditTransformer {
        from: Proj,
        to: Proj,
        vertical_unit_scale: f64,
        source_is_geographic: bool,
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
            let source_wkt = fixture.horizontal_wkt.as_deref().unwrap_or(&fixture.wkt);
            let proj_string =
                super::convert_wkt(source_wkt).map_err(|error| JsValue::from_str(&error))?;
            let from = Proj::from_proj_string(&proj_string)
                .map_err(|error| JsValue::from_str(&error.to_string()))?;
            let to = Proj::from_proj_string(WGS84_PROJ)
                .map_err(|error| JsValue::from_str(&error.to_string()))?;
            Ok(Self {
                from,
                to,
                vertical_unit_scale: fixture.vertical_unit_scale,
                source_is_geographic: proj_string.contains("+proj=longlat"),
            })
        }

        pub fn transform_points(
            &self,
            coordinates: &Float64Array,
        ) -> Result<Float64Array, JsValue> {
            let mut input = vec![0.0; coordinates.length() as usize];
            coordinates.copy_to(&mut input);
            let output = transform_flat_coordinates(
                &self.from,
                &self.to,
                &input,
                self.vertical_unit_scale,
                self.source_is_geographic,
            )
            .map_err(|error| JsValue::from_str(&error))?;
            Ok(Float64Array::from(output.as_slice()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{fixture_matrix, transform_fixture};

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
        assert!(
            super::convert_wkt(fixture.horizontal_wkt.as_ref().expect("horizontal WKT")).is_ok()
        );
    }
}
