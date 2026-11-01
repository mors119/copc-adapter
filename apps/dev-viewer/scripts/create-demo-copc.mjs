import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const projectedEllipsoidal = process.argv.includes("--projected-ellipsoidal");
const projected = process.argv.includes("--projected") || projectedEllipsoidal;
const explicitOutput = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
const outputPath = resolve(explicitOutput ?? join(
  repositoryRoot,
  projectedEllipsoidal
    ? "samples/local/demo-projected-ellipsoidal.copc.laz"
    : projected ? "samples/local/demo-projected.copc.laz" : "samples/local/demo-wgs84.copc.laz",
));

const projectedEllipsoidalWkt = `COMPD_CS["WGS 84 / UTM zone 11N + WGS 84 ellipsoidal height",PROJCS["WGS 84 / UTM zone 11N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-117],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","32611"]],VERT_CS["WGS 84 ellipsoidal height",VERT_DATUM["WGS 84 ellipsoid",2002],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Ellipsoidal height",UP]]]`;

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => rejectRun(error));
    child.on("close", (code) => {
      if (code === 0) resolveRun(Buffer.concat(stdout).toString("utf8"));
      else rejectRun(new Error(Buffer.concat(stderr).toString("utf8").trim() || `${command} exited ${code}`));
    });
  });
}

const workingDirectory = await mkdtemp(join(tmpdir(), "copc-tiles-demo-"));
try {
  await mkdir(resolve(outputPath, ".."), { recursive: true });
  const pointFile = join(workingDirectory, "ridge-park.csv");
  const pipelineFile = join(workingDirectory, "copc-pipeline.json");
  const rows = ["X,Y,Z,Red,Green,Blue,Intensity,Classification"];
  const columns = 512;
  const rowsCount = 256;
  for (let row = 0; row < rowsCount; row += 1) {
    const y = row / (rowsCount - 1);
    for (let column = 0; column < columns; column += 1) {
      const x = column / (columns - 1);
      const hills = [
        { x: 0.28, y: 0.36, width: 0.19, depth: 0.27, height: 0.09 },
        { x: 0.69, y: 0.62, width: 0.24, depth: 0.2, height: 0.14 },
        { x: 0.48, y: 0.77, width: 0.16, depth: 0.13, height: 0.07 },
      ];
      let elevation = 118;
      for (const hill of hills) {
        const dx = (x - hill.x) / hill.width;
        const dy = (y - hill.y) / hill.depth;
        const distance = Math.hypot(dx, dy);
        if (distance < 1) elevation += hill.height * (1 - distance) ** 1.6;
      }
      elevation += Math.sin(x * 29) * 0.004 + Math.cos(y * 21) * 0.003;
      const longitude = -122.8 + x * 0.4;
      const latitude = 45.3 + y * 0.4;
      const warm = Math.max(0, Math.min(1, (elevation - 118) / 0.3));
      const red = Math.round(58 + warm * 175);
      const green = Math.round(158 - warm * 85);
      const blue = Math.round(112 - warm * 55);
      const intensity = Math.round(2200 + warm * 1800);
      const classification = elevation > 145 ? 5 : 1;
      // EPSG:4326 declares latitude first and longitude second. Store the LAS
      // X/Y values in that declared axis order so Adapter's conservative
      // bounds and point transformer interpret the supported demo consistently.
      const coordinateX = projected ? 500_000 + x * 80 : latitude;
      const coordinateY = projected ? 5_020_000 + y * 80 : longitude;
      rows.push(`${coordinateX.toFixed(projected ? 3 : 9)},${coordinateY.toFixed(projected ? 3 : 9)},${elevation.toFixed(3)},${red},${green},${blue},${intensity},${classification}`);
    }
  }
  await writeFile(pointFile, rows.join("\n") + "\n");
  await writeFile(pipelineFile, JSON.stringify({
    pipeline: [
      {
        type: "readers.text",
        filename: pointFile,
        override_srs: projectedEllipsoidal
          ? projectedEllipsoidalWkt
          : projected ? "EPSG:32611" : "EPSG:4979",
      },
      {
        type: "writers.copc",
        filename: outputPath,
        a_srs: projectedEllipsoidal
          ? projectedEllipsoidalWkt
          : projected ? "EPSG:32611" : "EPSG:4979",
        enhanced_srs_vlrs: true,
        fixed_seed: true,
        scale_x: projected ? 0.001 : 0.00000001,
        scale_y: projected ? 0.001 : 0.00000001,
        scale_z: 0.001,
        offset_x: projected ? 500_000 : 45.3,
        offset_y: projected ? 5_020_000 : -122.8,
        offset_z: 118,
        software_id: "COPC Adapter Dev Viewer demo",
      },
    ],
  }));

  await run("pdal", ["pipeline", "-i", pipelineFile]);
  const info = JSON.parse(await run("pdal", ["info", "--summary", outputPath]));
  const bytes = (await stat(outputPath)).size;
  const pointCount = info.summary?.num_points;
  if (!Number.isSafeInteger(pointCount) || pointCount !== columns * rowsCount || bytes < 65_536 || bytes > 2 * 1024 * 1024) {
    throw new Error(`Generated COPC validation failed: points=${String(pointCount)}, bytes=${bytes}.`);
  }
  console.log(`Generated ${outputPath} · ${pointCount.toLocaleString()} points · ${(bytes / 1024).toFixed(1)} KiB · ${projectedEllipsoidal ? "projected EPSG:32611 with declared WGS 84 ellipsoidal metre height" : projected ? "projected EPSG:32611 fail-closed diagnostic with unknown height" : "WGS 84 EPSG:4326 with ellipsoidal height"}.`);
} catch (error) {
  if (error?.code === "ENOENT") {
    throw new Error("PDAL is required to generate the local demo COPC. Install PDAL with COPC reader/writer support, then rerun this command.", { cause: error });
  }
  throw error;
} finally {
  await rm(workingDirectory, { recursive: true, force: true });
}
