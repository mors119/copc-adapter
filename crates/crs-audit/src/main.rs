use std::env;

use crs_audit::{benchmark_fixture, evaluate_fixtures};

fn main() {
    let arguments: Vec<String> = env::args().skip(1).collect();
    if arguments
        .first()
        .is_some_and(|argument| argument == "--benchmark")
    {
        run_benchmarks();
        return;
    }

    println!(
        "{}",
        serde_json::to_string_pretty(&evaluate_fixtures()).expect("audit results serialize")
    );
}

fn run_benchmarks() {
    let sizes = [10_000, 100_000, 250_000, 500_000];
    for fixture_id in ["autzen-wkt1-compound-lcc", "sofi-wkt1-compound-utm11"] {
        for point_count in sizes {
            let result = benchmark_fixture(fixture_id, point_count, 5)
                .unwrap_or_else(|error| panic!("benchmark {fixture_id}/{point_count}: {error}"));
            println!(
                "{}",
                serde_json::to_string(&result).expect("benchmark result serializes")
            );
        }
    }
}
