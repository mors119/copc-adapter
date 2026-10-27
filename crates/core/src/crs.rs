use proj4rs::proj::Proj;
use proj4rs::transform::transform;
use proj4wkt::wkt_to_projstring;
use std::fmt;

use crate::error::{CopcError, Result};

const WGS84_PROJ: &str = "+proj=longlat +datum=WGS84 +no_defs";
const WGS84_SEMI_MAJOR_AXIS_METERS: f64 = 6_378_137.0;
const WGS84_FIRST_ECCENTRICITY_SQUARED: f64 = 6.694_379_990_141_316_5e-3;

fn allocate_coordinate_buffer(length: usize, what: &str) -> Result<Vec<f64>> {
    let mut values = Vec::new();
    values
        .try_reserve_exact(length)
        .map_err(|_| CopcError::new("allocation", format!("unable to allocate {what} buffer")))?;
    Ok(values)
}

/// A source-independent WGS84 geographic point.
///
/// Longitude and latitude are expressed in degrees. Height follows the
/// adapter's existing contract and is expressed in metres after the source
/// vertical unit scale has been applied.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GeographicPoint {
    pub longitude: f64,
    pub latitude: f64,
    pub height: f64,
}

/// A WGS84 earth-centred, earth-fixed point in metres.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EcefPoint {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// The reusable output of the common source -> geographic -> ECEF path.
#[derive(Clone, Debug, PartialEq)]
pub struct PreparedCoordinates {
    pub geographic: Vec<f64>,
    pub ecef: Vec<f64>,
}

/// An initialized source-CRS to WGS84 transform.
///
/// WKT parsing, PROJ string conversion, projection initialization, and
/// vertical unit interpretation happen once when this value is constructed.
/// The value can then be reused for every point buffer from the same dataset.
#[derive(Clone)]
pub struct CrsTransform {
    source: Proj,
    target: Proj,
    source_proj_string: String,
    vertical_unit_scale: f64,
    height_offset_meters: f64,
    source_is_geographic: bool,
    used_horizontal_fallback: bool,
    source_horizontal_axes: Option<[HorizontalAxisDirection; 2]>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HorizontalAxisDirection {
    East,
    West,
    North,
    South,
}

impl HorizontalAxisDirection {
    fn is_east_west(self) -> bool {
        matches!(self, Self::East | Self::West)
    }

    fn sign(self) -> f64 {
        match self {
            Self::East | Self::North => 1.0,
            Self::West | Self::South => -1.0,
        }
    }
}

impl fmt::Debug for CrsTransform {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CrsTransform")
            .field("source_proj_string", &self.source_proj_string)
            .field("vertical_unit_scale", &self.vertical_unit_scale)
            .field("height_offset_meters", &self.height_offset_meters)
            .field("source_is_geographic", &self.source_is_geographic)
            .field("used_horizontal_fallback", &self.used_horizontal_fallback)
            .finish()
    }
}

impl CrsTransform {
    /// Initialize a transform from a COPC WKT definition.
    ///
    /// The complete WKT is handed to `proj4wkt` first. If the complete
    /// definition is a compound WKT1 or WKT2 value that the current upstream
    /// parser cannot consume, the nested projected CRS definition is used as
    /// a focused compatibility path. Vertical units and axis order are still
    /// read from the original WKT and applied separately.
    pub fn from_wkt(wkt: &str) -> Result<Self> {
        if wkt.trim().is_empty() {
            return Err(CopcError::new("missing-wkt", "CRS WKT must not be empty"));
        }

        let vertical_unit_scale = extract_vertical_unit_scale(wkt)?;
        let source_horizontal_axes = extract_horizontal_axis_directions(wkt)?;
        let (source_proj_string, used_horizontal_fallback) = match wkt_to_projstring(wkt) {
            Ok(proj_string) => (proj_string, false),
            Err(full_error) => {
                let horizontal_wkt = extract_projected_wkt(wkt).ok_or_else(|| {
                    CopcError::new(
                        "crs-wkt-conversion",
                        format!("proj4wkt could not convert the COPC WKT: {full_error}"),
                    )
                })?;
                let proj_string = wkt_to_projstring(&horizontal_wkt).map_err(|horizontal_error| {
                    CopcError::new(
                        "crs-wkt-conversion",
                        format!("proj4wkt could not convert the COPC WKT ({full_error}); the projected horizontal fallback also failed: {horizontal_error}"),
                    )
                })?;
                (proj_string, true)
            }
        };

        Self::from_proj_string_with_scale(
            source_proj_string,
            vertical_unit_scale,
            used_horizontal_fallback,
            source_horizontal_axes,
        )
    }

    /// Initialize the identity geographic path used when COPC metadata has no
    /// WKT but its source bounds are already longitude/latitude values.
    pub fn from_geographic() -> Result<Self> {
        Self::from_proj_string_with_scale(WGS84_PROJ.to_owned(), 1.0, false, None)
    }

    /// Initialize from optional COPC metadata while preserving the current
    /// no-WKT geographic-source behavior.
    pub fn from_wkt_or_geographic(wkt: Option<&str>, bounds: [f64; 4]) -> Result<Self> {
        if let Some(wkt) = wkt {
            return Self::from_wkt(wkt);
        }

        let geographic_bounds = bounds.iter().all(|value| value.is_finite())
            && bounds[0] >= -180.0
            && bounds[2] <= 180.0
            && bounds[1] >= -90.0
            && bounds[3] <= 90.0;
        if geographic_bounds {
            Self::from_geographic()
        } else {
            Err(CopcError::new(
                "missing-wkt",
                "COPC metadata WKT is required for projected source coordinates",
            ))
        }
    }

    fn from_proj_string_with_scale(
        source_proj_string: String,
        vertical_unit_scale: f64,
        used_horizontal_fallback: bool,
        source_horizontal_axes: Option<[HorizontalAxisDirection; 2]>,
    ) -> Result<Self> {
        if !vertical_unit_scale.is_finite() || vertical_unit_scale <= 0.0 {
            return Err(CopcError::new(
                "invalid-value",
                "CRS vertical unit scale must be finite and positive",
            ));
        }

        let source = Proj::from_proj_string(&source_proj_string).map_err(|error| {
            CopcError::new(
                "crs-initialization",
                format!("proj4rs could not initialize the source CRS: {error}"),
            )
        })?;
        let target = Proj::from_proj_string(WGS84_PROJ).map_err(|error| {
            CopcError::new(
                "crs-initialization",
                format!("proj4rs could not initialize WGS84: {error}"),
            )
        })?;
        validate_axis(source.axis(), "source CRS")?;
        validate_axis(target.axis(), "WGS84 target CRS")?;
        if !source.has_inverse() || !target.has_forward() || !target.is_latlong() {
            return Err(CopcError::new(
                "unsupported-crs",
                "CRS transform requires an invertible source and geographic WGS84 target",
            ));
        }

        Ok(Self {
            source_is_geographic: source.is_latlong(),
            source,
            target,
            source_proj_string,
            vertical_unit_scale,
            height_offset_meters: 0.0,
            used_horizontal_fallback,
            source_horizontal_axes,
        })
    }

    /// Set a manual additive correction in ellipsoidal metres.
    pub fn with_height_offset_meters(mut self, height_offset_meters: f64) -> Result<Self> {
        if !height_offset_meters.is_finite() {
            return Err(CopcError::new(
                "invalid-value",
                "ellipsoidal height offset must be finite",
            ));
        }
        self.height_offset_meters = height_offset_meters;
        Ok(self)
    }

    pub fn source_proj_string(&self) -> &str {
        &self.source_proj_string
    }

    pub fn vertical_unit_scale(&self) -> f64 {
        self.vertical_unit_scale
    }

    pub fn used_horizontal_fallback(&self) -> bool {
        self.used_horizontal_fallback
    }

    /// Transform one source XYZ value into WGS84 longitude/latitude/height.
    pub fn transform_point(&self, source: [f64; 3]) -> Result<GeographicPoint> {
        if source.iter().any(|value| !value.is_finite()) {
            return Err(CopcError::new(
                "non-finite-input",
                "CRS source coordinates must be finite",
            ));
        }

        // proj4rs uses radians for geographic coordinates. COPC's geographic
        // boundary and the TypeScript reference use degrees.
        let [first_horizontal, second_horizontal] =
            normalize_horizontal_axes(source[0], source[1], self.source_horizontal_axes);
        let mut transformed = if self.source_is_geographic {
            (
                first_horizontal.to_radians(),
                second_horizontal.to_radians(),
                0.0,
            )
        } else {
            (first_horizontal, second_horizontal, 0.0)
        };
        transform(&self.source, &self.target, &mut transformed).map_err(|error| {
            CopcError::new(
                "crs-transform",
                format!("proj4rs failed to transform source coordinates: {error}"),
            )
        })?;

        let converted_height = source[2] * self.vertical_unit_scale;
        let point = GeographicPoint {
            longitude: transformed.0.to_degrees(),
            latitude: transformed.1.to_degrees(),
            height: if self.height_offset_meters == 0.0 {
                converted_height
            } else {
                converted_height + self.height_offset_meters
            },
        };
        if [point.longitude, point.latitude, point.height]
            .iter()
            .any(|value| !value.is_finite())
        {
            return Err(CopcError::new(
                "non-finite-output",
                "CRS transformation produced non-finite geographic coordinates",
            ));
        }
        Ok(point)
    }

    /// Transform an interleaved source XYZ buffer into geographic triples.
    pub fn transform_buffer(&self, source_coordinates: &[f64]) -> Result<Vec<f64>> {
        if !source_coordinates.len().is_multiple_of(3) {
            return Err(CopcError::new(
                "invalid-value",
                "source coordinate buffer must contain XYZ triples",
            ));
        }

        let mut geographic = allocate_coordinate_buffer(source_coordinates.len(), "geographic")?;
        for &values in source_coordinates.as_chunks::<3>().0 {
            let point = self.transform_point(values)?;
            geographic.extend([point.longitude, point.latitude, point.height]);
        }
        Ok(geographic)
    }

    /// Transform source XYZ to both WGS84 geographic and ECEF buffers in one
    /// reusable core operation.
    pub fn transform_buffer_to_ecef(
        &self,
        source_coordinates: &[f64],
    ) -> Result<PreparedCoordinates> {
        if !source_coordinates.len().is_multiple_of(3) {
            return Err(CopcError::new(
                "invalid-value",
                "source coordinate buffer must contain XYZ triples",
            ));
        }

        let mut geographic = allocate_coordinate_buffer(source_coordinates.len(), "geographic")?;
        let mut ecef = allocate_coordinate_buffer(source_coordinates.len(), "ECEF")?;
        for &values in source_coordinates.as_chunks::<3>().0 {
            let point = self.transform_point(values)?;
            let world = geographic_to_ecef(point)?;
            geographic.extend([point.longitude, point.latitude, point.height]);
            ecef.extend([world.x, world.y, world.z]);
        }
        Ok(PreparedCoordinates { geographic, ecef })
    }
}

/// Convert WGS84 longitude/latitude/ellipsoidal height into ECEF metres.
pub fn geographic_to_ecef(point: GeographicPoint) -> Result<EcefPoint> {
    if [point.longitude, point.latitude, point.height]
        .iter()
        .any(|value| !value.is_finite())
    {
        return Err(CopcError::new(
            "non-finite-input",
            "WGS84 geographic coordinates must be finite",
        ));
    }

    let longitude = point.longitude.to_radians();
    let latitude = point.latitude.to_radians();
    let sin_latitude = latitude.sin();
    let cos_latitude = latitude.cos();
    let radius_of_curvature = WGS84_SEMI_MAJOR_AXIS_METERS
        / (1.0 - WGS84_FIRST_ECCENTRICITY_SQUARED * sin_latitude.powi(2)).sqrt();
    let horizontal_radius = radius_of_curvature + point.height;
    let polar_radius =
        radius_of_curvature * (1.0 - WGS84_FIRST_ECCENTRICITY_SQUARED) + point.height;
    let ecef = EcefPoint {
        x: horizontal_radius * cos_latitude * longitude.cos(),
        y: horizontal_radius * cos_latitude * longitude.sin(),
        z: polar_radius * sin_latitude,
    };

    if [ecef.x, ecef.y, ecef.z]
        .iter()
        .any(|value| !value.is_finite())
    {
        return Err(CopcError::new(
            "non-finite-output",
            "WGS84 ECEF conversion produced non-finite coordinates",
        ));
    }
    Ok(ecef)
}

/// Convert an interleaved WGS84 geographic buffer into ECEF triples.
pub fn geographic_buffer_to_ecef(geographic_coordinates: &[f64]) -> Result<Vec<f64>> {
    if !geographic_coordinates.len().is_multiple_of(3) {
        return Err(CopcError::new(
            "invalid-value",
            "geographic coordinate buffer must contain XYZ triples",
        ));
    }

    let mut ecef = allocate_coordinate_buffer(geographic_coordinates.len(), "ECEF")?;
    for &values in geographic_coordinates.as_chunks::<3>().0 {
        let point = geographic_to_ecef(GeographicPoint {
            longitude: values[0],
            latitude: values[1],
            height: values[2],
        })?;
        ecef.extend([point.x, point.y, point.z]);
    }
    Ok(ecef)
}

fn validate_axis(axis: &[u8; 3], label: &str) -> Result<()> {
    let valid = axis
        .iter()
        .all(|direction| matches!(direction, b'e' | b'w' | b'n' | b's' | b'u' | b'd'));
    if valid {
        Ok(())
    } else {
        Err(CopcError::new(
            "unsupported-axis",
            format!("{label} has an unsupported axis definition"),
        ))
    }
}

fn extract_projected_wkt(wkt: &str) -> Option<String> {
    find_section(wkt, "PROJCS[")
        .or_else(|| find_section(wkt, "PROJCRS["))
        .map(str::to_owned)
}

fn normalize_horizontal_axes(
    first: f64,
    second: f64,
    axes: Option<[HorizontalAxisDirection; 2]>,
) -> [f64; 2] {
    let Some(axes) = axes else {
        return [first, second];
    };

    let mut east = 0.0;
    let mut north = 0.0;
    for (value, direction) in [(first, axes[0]), (second, axes[1])] {
        if direction.is_east_west() {
            east = value * direction.sign();
        } else {
            north = value * direction.sign();
        }
    }
    [east, north]
}

fn extract_horizontal_axis_directions(wkt: &str) -> Result<Option<[HorizontalAxisDirection; 2]>> {
    let horizontal_crs = ["PROJCS[", "PROJCRS[", "GEOGCS[", "GEOGCRS["]
        .into_iter()
        .filter_map(|keyword| find_keyword(wkt, keyword).map(|position| (position, keyword)))
        .min_by_key(|(position, _)| *position)
        .and_then(|(_, keyword)| find_section(wkt, keyword));
    let Some(horizontal_crs) = horizontal_crs else {
        return Ok(None);
    };

    let mut axes = find_direct_sections(horizontal_crs, "AXIS[")
        .into_iter()
        .enumerate()
        .map(|(index, axis)| Ok((parse_axis_order(axis)?.unwrap_or(index + 1), axis)))
        .collect::<Result<Vec<_>>>()?;
    if axes.is_empty() {
        return Ok(None);
    }
    axes.sort_by_key(|(order, _)| *order);
    if axes.len() < 2 || axes.windows(2).any(|pair| pair[0].0 == pair[1].0) {
        return Err(CopcError::new(
            "unsupported-axis",
            "horizontal CRS must declare two ordered horizontal axes",
        ));
    }

    let first = parse_axis_direction(axes[0].1)?;
    let second = parse_axis_direction(axes[1].1)?;
    if first.is_east_west() == second.is_east_west() {
        return Err(CopcError::new(
            "unsupported-axis",
            "horizontal CRS axes must contain one east/west and one north/south direction",
        ));
    }
    Ok(Some([first, second]))
}

fn parse_axis_direction(axis: &str) -> Result<HorizontalAxisDirection> {
    let bytes = axis.as_bytes();
    let mut in_string = false;
    let mut comma = None;
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'"' if in_string && bytes.get(index + 1) == Some(&b'"') => {
                index += 2;
                continue;
            }
            b'"' => in_string = !in_string,
            b',' if !in_string => {
                comma = Some(index + 1);
                break;
            }
            _ => {}
        }
        index += 1;
    }
    let Some(mut start) = comma else {
        return Err(CopcError::new(
            "malformed-wkt",
            "horizontal CRS axis direction is missing",
        ));
    };
    while bytes.get(start).is_some_and(u8::is_ascii_whitespace) {
        start += 1;
    }
    let mut end = start;
    while bytes
        .get(end)
        .is_some_and(|byte| byte.is_ascii_alphabetic())
    {
        end += 1;
    }
    let direction = axis[start..end].to_ascii_lowercase();
    match direction.as_str() {
        "east" => Ok(HorizontalAxisDirection::East),
        "west" => Ok(HorizontalAxisDirection::West),
        "north" => Ok(HorizontalAxisDirection::North),
        "south" => Ok(HorizontalAxisDirection::South),
        _ => Err(CopcError::new(
            "unsupported-axis",
            format!("horizontal CRS axis direction {direction:?} is unsupported"),
        )),
    }
}

fn parse_axis_order(axis: &str) -> Result<Option<usize>> {
    let Some(order) = find_section(axis, "ORDER[") else {
        return Ok(None);
    };
    let open = order
        .find('[')
        .ok_or_else(|| CopcError::new("malformed-wkt", "horizontal CRS axis order is malformed"))?;
    let close = order
        .rfind(']')
        .ok_or_else(|| CopcError::new("malformed-wkt", "horizontal CRS axis order is malformed"))?;
    let value = order[open + 1..close]
        .trim()
        .parse::<usize>()
        .map_err(|_| CopcError::new("malformed-wkt", "horizontal CRS axis order is invalid"))?;
    if value == 0 {
        return Err(CopcError::new(
            "malformed-wkt",
            "horizontal CRS axis order must be positive",
        ));
    }
    Ok(Some(value))
}

fn find_direct_sections<'a>(section: &'a str, keyword: &str) -> Vec<&'a str> {
    let Some(root_open) = section.find('[') else {
        return Vec::new();
    };
    let bytes = section.as_bytes();
    let keyword_name = keyword.strip_suffix('[').unwrap_or(keyword).as_bytes();
    let mut matches = Vec::new();
    let mut index = root_open + 1;
    let mut depth = 1usize;
    let mut in_string = false;

    while index < bytes.len() {
        match bytes[index] {
            b'"' if in_string && bytes.get(index + 1) == Some(&b'"') => {
                index += 2;
                continue;
            }
            b'"' => in_string = !in_string,
            _ => {}
        }
        if in_string {
            index += 1;
            continue;
        }

        if depth == 1
            && index + keyword_name.len() <= bytes.len()
            && bytes[index..index + keyword_name.len()].eq_ignore_ascii_case(keyword_name)
            && (index == 0 || !bytes[index - 1].is_ascii_alphanumeric() && bytes[index - 1] != b'_')
        {
            let mut open = index + keyword_name.len();
            while bytes.get(open).is_some_and(u8::is_ascii_whitespace) {
                open += 1;
            }
            if bytes.get(open) == Some(&b'[') {
                if let Some(axis) = find_section(&section[index..], keyword) {
                    matches.push(axis);
                    index += axis.len();
                    continue;
                }
            }
        }

        match bytes[index] {
            b'[' => depth += 1,
            b']' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    break;
                }
            }
            _ => {}
        }
        index += 1;
    }
    matches
}

fn extract_vertical_unit_scale(wkt: &str) -> Result<f64> {
    let Some(section) = find_section(wkt, "VERT_CS[").or_else(|| find_section(wkt, "VERTCRS["))
    else {
        return Ok(1.0);
    };

    let Some(unit) =
        find_section(section, "UNIT[").or_else(|| find_section(section, "LENGTHUNIT["))
    else {
        return Ok(1.0);
    };
    let Some(open) = unit.find('[') else {
        return Err(CopcError::new(
            "malformed-wkt",
            "vertical CRS unit section is malformed",
        ));
    };
    let mut cursor = open + 1;
    if unit.as_bytes().get(cursor) != Some(&b'"') {
        return Err(CopcError::new(
            "malformed-wkt",
            "vertical CRS unit name is malformed",
        ));
    }
    cursor += 1;
    while cursor < unit.len() {
        if unit.as_bytes()[cursor] == b'"' {
            if unit.as_bytes().get(cursor + 1) == Some(&b'"') {
                cursor += 2;
                continue;
            }
            break;
        }
        cursor += 1;
    }
    if cursor >= unit.len() {
        return Err(CopcError::new(
            "malformed-wkt",
            "vertical CRS unit name is unterminated",
        ));
    }
    cursor += 1;
    if unit.as_bytes().get(cursor) != Some(&b',') {
        return Err(CopcError::new(
            "malformed-wkt",
            "vertical CRS unit scale is missing",
        ));
    }
    cursor += 1;
    let scale_start = cursor;
    while cursor < unit.len() && !matches!(unit.as_bytes()[cursor], b',' | b']') {
        cursor += 1;
    }
    let scale = unit[scale_start..cursor]
        .trim()
        .parse::<f64>()
        .map_err(|_| CopcError::new("malformed-wkt", "vertical CRS unit scale is not numeric"))?;
    if !scale.is_finite() || scale <= 0.0 {
        return Err(CopcError::new(
            "invalid-value",
            "vertical CRS unit scale must be finite and positive",
        ));
    }
    Ok(scale)
}

fn find_section<'a>(wkt: &'a str, keyword: &str) -> Option<&'a str> {
    let start = find_keyword(wkt, keyword)?;
    let mut depth = 0usize;
    let mut in_string = false;
    let bytes = wkt.as_bytes();
    let mut index = start;
    while index < bytes.len() {
        match bytes[index] {
            b'"' if in_string && bytes.get(index + 1) == Some(&b'"') => {
                index += 2;
                continue;
            }
            b'"' => in_string = !in_string,
            b'[' if !in_string => depth += 1,
            b']' if !in_string => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(&wkt[start..=index]);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

fn find_keyword(wkt: &str, keyword: &str) -> Option<usize> {
    let bytes = wkt.as_bytes();
    let keyword_ends_with_bracket = keyword.ends_with('[');
    let keyword_name = keyword.strip_suffix('[').unwrap_or(keyword).as_bytes();
    let mut in_string = false;
    let mut index = 0usize;
    while index + keyword_name.len() <= bytes.len() {
        if bytes[index] == b'"' {
            if in_string && bytes.get(index + 1) == Some(&b'"') {
                index += 2;
                continue;
            }
            in_string = !in_string;
            index += 1;
            continue;
        }
        if !in_string
            && bytes[index..index + keyword_name.len()].eq_ignore_ascii_case(keyword_name)
            && (index == 0 || !bytes[index - 1].is_ascii_alphanumeric() && bytes[index - 1] != b'_')
        {
            let mut end = index + keyword_name.len();
            if keyword_ends_with_bracket {
                while bytes.get(end).is_some_and(u8::is_ascii_whitespace) {
                    end += 1;
                }
                if bytes.get(end) == Some(&b'[') {
                    return Some(index);
                }
            } else {
                return Some(index);
            }
        }
        index += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{
        CrsTransform, GeographicPoint, HorizontalAxisDirection, extract_horizontal_axis_directions,
        geographic_to_ecef,
    };

    const WGS84_GEOGRAPHIC_WKT: &str = "GEOGCS[\"WGS 84\",DATUM[\"WGS_1984\",SPHEROID[\"WGS 84\",6378137,298.257223563]],PRIMEM[\"Greenwich\",0],UNIT[\"degree\",0.0174532925199433]]";
    const UTM_WKT: &str = "PROJCS[\"WGS 84 / UTM zone 11N\",GEOGCS[\"WGS 84\",DATUM[\"WGS84\",SPHEROID[\"WGS84\",6378137,298.257223563]],PRIMEM[\"Greenwich\",0],UNIT[\"degree\",0.0174532925199433]],PROJECTION[\"Transverse_Mercator\"],PARAMETER[\"latitude_of_origin\",0],PARAMETER[\"central_meridian\",-117],PARAMETER[\"scale_factor\",0.9996],PARAMETER[\"false_easting\",500000],PARAMETER[\"false_northing\",0],UNIT[\"metre\",1]]";
    const COMPOUND_UTM_WKT: &str = "COMPD_CS[\"WGS 84 / UTM zone 11N\",PROJCS[\"WGS 84 / UTM zone 11N\",GEOGCS[\"WGS 84\",DATUM[\"WGS84\",SPHEROID[\"WGS84\",6378137,298.257223563]],PRIMEM[\"Greenwich\",0],UNIT[\"degree\",0.0174532925199433]],PROJECTION[\"Transverse_Mercator\"],PARAMETER[\"latitude_of_origin\",0],PARAMETER[\"central_meridian\",-117],PARAMETER[\"scale_factor\",0.9996],PARAMETER[\"false_easting\",500000],PARAMETER[\"false_northing\",0],UNIT[\"metre\",1]],VERT_CS[\"height\",VERT_DATUM[\"height\",2005],UNIT[\"US survey foot\",0.304800609601219]]]";

    #[test]
    fn transforms_geographic_degrees_and_applies_vertical_units() {
        let transform = CrsTransform::from_wkt(WGS84_GEOGRAPHIC_WKT).unwrap();
        let point = transform
            .transform_point([-122.6784, 45.5231, 123.5])
            .unwrap();
        assert!((point.longitude + 122.6784).abs() < 1e-12);
        assert!((point.latitude - 45.5231).abs() < 1e-12);
        assert_eq!(point.height, 123.5);
    }

    #[test]
    fn transforms_projected_coordinates_and_reuses_initialized_state() {
        let transform = CrsTransform::from_wkt(UTM_WKT).unwrap();
        let first = transform
            .transform_point([376392.9975, 3757833.2855, 545.1945])
            .unwrap();
        let second = transform
            .transform_point([375764.094, 3757204.382, -83.709])
            .unwrap();
        assert!((first.longitude + 118.33772305286695).abs() < 1e-7);
        assert!((first.latitude - 33.95374438756227).abs() < 1e-7);
        assert_eq!(first.height, 545.1945);
        assert!((second.longitude + 118.34443846366064).abs() < 1e-7);
    }

    #[test]
    fn orders_horizontal_axes_by_wkt_order_fields() {
        let wkt = "PROJCRS[\"axis order\",CS[Cartesian,2],AXIS[\"northing\",north,ORDER[2]],AXIS[\"easting\",east,ORDER[1]]]";
        assert_eq!(
            extract_horizontal_axis_directions(wkt).unwrap(),
            Some([
                HorizontalAxisDirection::East,
                HorizontalAxisDirection::North
            ])
        );
    }

    #[test]
    fn ignores_a_third_vertical_axis_when_mapping_geographic_coordinates() {
        let wkt = "GEOGCRS[\"WGS 84\",CS[ellipsoidal,3],AXIS[\"latitude\",north,ORDER[1]],AXIS[\"longitude\",east,ORDER[2]],AXIS[\"height\",up,ORDER[3]]]";
        assert_eq!(
            extract_horizontal_axis_directions(wkt).unwrap(),
            Some([
                HorizontalAxisDirection::North,
                HorizontalAxisDirection::East
            ])
        );
    }

    #[test]
    fn transforms_compound_wkt_and_preserves_vertical_scale() {
        let transform = CrsTransform::from_wkt(COMPOUND_UTM_WKT).unwrap();
        let point = transform
            .transform_point([376392.9975, 3757833.2855, 545.1945])
            .unwrap();
        assert!((point.longitude + 118.33772305286695).abs() < 1e-7);
        assert!((point.height - 545.1945 * 0.304800609601219).abs() < 1e-12);
    }

    #[test]
    fn transforms_vertical_units_with_whitespace_before_the_bracket() {
        let spaced_unit_wkt =
            COMPOUND_UTM_WKT.replace("UNIT[\"US survey foot\"", "UNIT [\"US survey foot\"");
        let transform = CrsTransform::from_wkt(&spaced_unit_wkt).unwrap();
        let point = transform
            .transform_point([376392.9975, 3757833.2855, 545.1945])
            .unwrap();
        assert!((point.height - 545.1945 * 0.304800609601219).abs() < 1e-12);
    }

    #[test]
    fn applies_manual_offset_after_vertical_unit_conversion() {
        let transform = CrsTransform::from_wkt(COMPOUND_UTM_WKT)
            .unwrap()
            .with_height_offset_meters(17.25)
            .unwrap();
        let point = transform
            .transform_point([376392.9975, 3757833.2855, 545.1945])
            .unwrap();
        assert!((point.height - (545.1945 * 0.304800609601219 + 17.25)).abs() < 1e-12);
        assert!(
            CrsTransform::from_wkt(WGS84_GEOGRAPHIC_WKT)
                .unwrap()
                .with_height_offset_meters(f64::NAN)
                .is_err()
        );
    }

    #[test]
    fn converts_wgs84_geographic_to_ecef() {
        let origin = geographic_to_ecef(GeographicPoint {
            longitude: 0.0,
            latitude: 0.0,
            height: 0.0,
        })
        .unwrap();
        assert_eq!(origin.x, 6378137.0);
        assert_eq!(origin.y, 0.0);
        assert_eq!(origin.z, 0.0);

        let pole = geographic_to_ecef(GeographicPoint {
            longitude: 0.0,
            latitude: 90.0,
            height: 0.0,
        })
        .unwrap();
        assert!(pole.x.abs() < 1e-9);
        assert!(pole.y.abs() < 1e-9);
        assert!((pole.z - 6356752.314245179).abs() < 1e-9);
    }

    #[test]
    fn prepares_geographic_and_ecef_buffers_together() {
        let transform = CrsTransform::from_wkt(WGS84_GEOGRAPHIC_WKT).unwrap();
        let prepared = transform
            .transform_buffer_to_ecef(&[0.0, 0.0, 0.0, 90.0, 0.0, 10.0])
            .unwrap();
        assert_eq!(prepared.geographic.len(), 6);
        assert_eq!(prepared.ecef.len(), 6);
        assert_eq!(prepared.ecef[0], 6378137.0);
        assert!((prepared.ecef[4] - 6378147.0).abs() < 1e-9);
    }

    #[test]
    fn reports_structured_errors_for_bad_inputs() {
        assert_eq!(
            CrsTransform::from_wkt("").unwrap_err().code(),
            "missing-wkt"
        );
        let transform = CrsTransform::from_wkt(WGS84_GEOGRAPHIC_WKT).unwrap();
        assert_eq!(
            transform
                .transform_point([f64::NAN, 0.0, 0.0])
                .unwrap_err()
                .code(),
            "non-finite-input"
        );
        assert_eq!(
            transform.transform_buffer(&[0.0, 0.0]).unwrap_err().code(),
            "invalid-value"
        );
        assert_eq!(
            geographic_to_ecef(GeographicPoint {
                longitude: f64::INFINITY,
                latitude: 0.0,
                height: 0.0,
            })
            .unwrap_err()
            .code(),
            "non-finite-input"
        );
    }

    #[test]
    fn supports_geographic_sources_without_a_wkt() {
        let transform =
            CrsTransform::from_wkt_or_geographic(None, [-10.0, -5.0, 10.0, 5.0]).unwrap();
        let point = transform.transform_point([2.0, 3.0, 4.0]).unwrap();
        assert!((point.longitude - 2.0).abs() < 1e-12);
        assert!((point.latitude - 3.0).abs() < 1e-12);
        assert_eq!(point.height, 4.0);
        assert_eq!(
            CrsTransform::from_wkt_or_geographic(None, [1000.0, 0.0, 1001.0, 1.0])
                .unwrap_err()
                .code(),
            "missing-wkt"
        );
    }
}
