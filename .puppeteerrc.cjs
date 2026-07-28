const { join } = require("path");

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Store Chrome inside the project directory so Render keeps it during runtime
  cacheDirectory: join(__dirname, ".puppeteer"),
};
