import { expect, test } from "@playwright/test";
import { completeOnboarding, signup } from "./helpers";

test("create group from + and see two bots in one transcript", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `group-${stamp}@rakazo.test`, "password12", "Group E2E");
  await completeOnboarding(page, ["A bit of everything", "Clear and tight"]);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  await page.getByTitle("Create").click();
  await page.getByRole("button", { name: "New bot" }).click();
  await page.locator("label:has-text('Name') input").fill("Researcher");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/app\/[^/]+$/);

  await page.getByTitle("Create").click();
  await page.getByRole("button", { name: "New bot" }).click();
  await page.locator("label:has-text('Name') input").fill("Writer");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/app\/[^/]+$/);

  await page.getByTitle("Create").click();
  await page.getByRole("button", { name: "New group" }).click();
  await page.locator("label:has-text('Name') input").fill("Draft team");
  await page.getByRole("button", { name: "Researcher" }).click();
  await page.getByRole("button", { name: "Writer" }).click();
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await page.waitForURL(/\/app\/g\/[^/]+$/);

  const composer = page.getByPlaceholder("Message Draft team");
  await composer.fill("@Researcher gather sources. @Writer turn them into a draft.");
  await composer.press("Enter");

  await expect(page.getByTestId("transcript")).toContainText(/handled|on it|gather/i, {
    timeout: 60_000,
  });
  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByText("Researcher", { exact: true }).first()).toBeVisible();
  await expect(transcript.getByText("Writer", { exact: true }).first()).toBeVisible();
});
