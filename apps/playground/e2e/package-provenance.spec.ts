import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const playgroundPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  devDependencies: { "@frillab/copc-adapter": string };
};

test("shows the exact published npm adapter version and origin", async ({
  page,
}) => {
  await page.goto("./");

  await expect(page.locator("#package-source")).toHaveText(
    `npm release ${playgroundPackage.devDependencies["@frillab/copc-adapter"]} / Playground`,
  );
});
