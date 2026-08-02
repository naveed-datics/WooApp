const fs = require('fs')
const path = require('path')
const AdmZip = require('adm-zip')

const PARENT_CSV_NAME = 'wordpressdatafullparent.csv'
const VARIATIONS_CSV_NAME = 'wordpressdatafullvariations.csv'
const WORDPRESS_DATA_URL =
  'https://shop.ralawise.com/marketing-hub/web-data/wordpress/'
const RALAWISE_HOME = 'https://shop.ralawise.com/'

/**
 * Download a ZIP from url and validate it is not an HTML/unauthorized response.
 * @returns {Promise<Buffer>}
 */
async function downloadZip(url, label) {
  if (!url || typeof url !== 'string') {
    throw new Error(`Missing ${label} download URL`)
  }

  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      Accept: 'application/zip,application/x-zip-compressed,*/*',
      'User-Agent': 'WooApp-RalawiseSync/1.0',
    },
  })

  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  const finalUrl = response.url || url

  if (!response.ok) {
    throw new Error(
      `Failed to download ${label}: HTTP ${response.status} from ${finalUrl}`
    )
  }

  if (
    contentType.includes('text/html') ||
    finalUrl.includes('unauthorize') ||
    finalUrl.includes('transit-unauthorized')
  ) {
    throw new Error(
      `Unauthorized or expired download link for ${label}. Refresh RALAWISE_*_URL (?t=) or configure Ralawise login credentials.`
    )
  }

  const buffer = Buffer.from(await response.arrayBuffer())

  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    const peek = buffer.slice(0, 200).toString('utf8')
    if (peek.includes('unauthorize') || peek.includes('<html')) {
      throw new Error(
        `Unauthorized or expired download link for ${label}. Refresh RALAWISE_*_URL (?t=) or configure Ralawise login credentials.`
      )
    }
    throw new Error(`Downloaded ${label} is not a valid ZIP file`)
  }

  return buffer
}

function extractCsvFromZip(zipBuffer, preferredName, label) {
  const zip = new AdmZip(zipBuffer)
  const entries = zip.getEntries().filter((e) => !e.isDirectory)

  let entry =
    entries.find((e) => path.basename(e.entryName).toLowerCase() === preferredName) ||
    entries.find((e) => path.basename(e.entryName).toLowerCase().endsWith('.csv'))

  if (!entry) {
    throw new Error(`No CSV found inside ${label} ZIP`)
  }

  return {
    fileName: path.basename(entry.entryName),
    content: entry.getData().toString('utf8'),
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function writeCatalogFromZips({ dir, parentZip, variationsZip }) {
  const parentZipPath = path.join(dir, 'parent.zip')
  const variationsZipPath = path.join(dir, 'variations.zip')
  const parentCsvPath = path.join(dir, PARENT_CSV_NAME)
  const variationsCsvPath = path.join(dir, VARIATIONS_CSV_NAME)

  fs.writeFileSync(parentZipPath, parentZip)
  fs.writeFileSync(variationsZipPath, variationsZip)

  const parentCsv = extractCsvFromZip(parentZip, PARENT_CSV_NAME, 'products')
  const variationsCsv = extractCsvFromZip(
    variationsZip,
    VARIATIONS_CSV_NAME,
    'variations'
  )

  fs.writeFileSync(parentCsvPath, parentCsv.content, 'utf8')
  fs.writeFileSync(variationsCsvPath, variationsCsv.content, 'utf8')

  return {
    workDir: dir,
    parentCsvPath,
    variationsCsvPath,
    parentCsvText: parentCsv.content,
    variationsCsvText: variationsCsv.content,
  }
}

async function reportProgress(onProgress, payload) {
  if (typeof onProgress === 'function') {
    await onProgress(payload)
  }
}

/**
 * Download parent + variations ZIPs via public URLs and write CSVs to workDir.
 */
async function downloadCatalog({ parentUrl, variationsUrl, workDir, onProgress }) {
  const dir =
    workDir ||
    path.join(process.cwd(), 'tmp', 'ralawise', `run-${Date.now()}`)

  ensureDir(dir)

  const parentCsvPath = path.join(dir, PARENT_CSV_NAME)
  const variationsCsvPath = path.join(dir, VARIATIONS_CSV_NAME)

  try {
    await reportProgress(onProgress, {
      step: 'downloading',
      message: 'Downloading latest catalog ZIPs…',
    })
    const [parentZip, variationsZip] = await Promise.all([
      downloadZip(parentUrl, 'products'),
      downloadZip(variationsUrl, 'variations'),
    ])
    return {
      ...writeCatalogFromZips({ dir, parentZip, variationsZip }),
      source: 'env-url',
    }
  } catch (error) {
    for (const file of [parentCsvPath, variationsCsvPath]) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file)
      } catch {
        // ignore
      }
    }
    throw error
  }
}

function getEnvDownloadUrls() {
  const parentUrl = process.env.RALAWISE_PARENT_URL || ''
  const variationsUrl = process.env.RALAWISE_VARIATIONS_URL || ''
  return {
    parentUrl: parentUrl.trim(),
    variationsUrl: variationsUrl.trim(),
  }
}

function toAbsoluteUrl(href) {
  return new URL(href, RALAWISE_HOME).toString()
}

async function isZipUrlUsable(url) {
  if (!url) return false
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Range: 'bytes=0-3',
        'User-Agent': 'WooApp-RalawiseSync/1.0',
      },
    })
    clearTimeout(timer)

    const finalUrl = response.url || url
    if (
      finalUrl.includes('unauthorize') ||
      finalUrl.includes('transit-unauthorized')
    ) {
      return false
    }
    if (!response.ok) return false
    const contentType = (response.headers.get('content-type') || '').toLowerCase()
    if (contentType.includes('text/html')) return false
    const buf = Buffer.from(await response.arrayBuffer())
    return buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b
  } catch {
    return false
  }
}

async function launchBrowser(chromium) {
  try {
    return await chromium.launch({ headless: true })
  } catch (launchError) {
    try {
      return await chromium.launch({ headless: true, channel: 'chrome' })
    } catch {
      throw new Error(
        `Playwright browser launch failed (${launchError.message}). Run: npx playwright install chromium`
      )
    }
  }
}

async function loginRalawise(page, email, password) {
  await page.goto(RALAWISE_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 })

  const acceptCookies = page.locator(
    '#onetrust-accept-btn-handler, button:has-text("Accept All"), button:has-text("Accept")'
  )
  try {
    if (await acceptCookies.first().isVisible({ timeout: 5000 })) {
      await acceptCookies.first().click({ timeout: 5000 })
      await page.waitForTimeout(500)
    }
  } catch {
    // no cookie banner
  }
  await page.evaluate(() => {
    const sdk = document.getElementById('onetrust-consent-sdk')
    if (sdk) sdk.remove()
    document
      .querySelectorAll('.onetrust-pc-dark-filter')
      .forEach((el) => el.remove())
  })

  const emailField = page.locator('#EmailAddress').first()
  const passwordField = page.locator('#Password').first()
  await emailField.waitFor({ state: 'visible', timeout: 15000 })
  await emailField.fill(email)
  await passwordField.fill(password)
  await page.locator('#login').first().click({ force: true })
  await page.waitForTimeout(3000)
}

async function scrapeDownloadHrefs(page) {
  await page.goto(WORDPRESS_DATA_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  })

  if (page.url().includes('unauthorize')) {
    throw new Error('Ralawise login failed — check RALAWISE_EMAIL / RALAWISE_PASSWORD')
  }

  const links = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'))
    const find = (needle) => {
      const el = anchors.find((a) => {
        const text = (a.textContent || '').trim().toLowerCase()
        const href = (a.getAttribute('href') || '').toLowerCase()
        return text.includes(needle) || href.includes(needle)
      })
      return el ? el.getAttribute('href') : null
    }
    const zipHrefs = anchors
      .map((a) => a.getAttribute('href'))
      .filter((h) => h && h.includes('webdatadownloads'))
    return {
      parentHref:
        find('wordpressdatafullparent') ||
        find('download - products') ||
        zipHrefs.find((h) => h.includes('wordpressdatafullparent')),
      variationsHref:
        find('wordpressdatafullvariations') ||
        find('download - variations') ||
        zipHrefs.find((h) => h.includes('wordpressdatafullvariations')),
    }
  })

  if (!links.parentHref || !links.variationsHref) {
    throw new Error('Could not find Ralawise WordPress download links after login')
  }

  return {
    parentUrl: toAbsoluteUrl(links.parentHref),
    variationsUrl: toAbsoluteUrl(links.variationsHref),
  }
}

async function downloadZipWithContext(requestContext, url, label) {
  const response = await requestContext.get(url, { timeout: 120000 })
  if (!response.ok()) {
    throw new Error(`Authenticated download failed for ${label}: HTTP ${response.status()}`)
  }
  const buffer = Buffer.from(await response.body())
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error(
      `Authenticated download for ${label} did not return a ZIP (login may have failed)`
    )
  }
  return buffer
}

/**
 * Login, scrape fresh ?t= links, download ZIPs with session cookies.
 */
async function downloadCatalogWithPlaywright({
  email = process.env.RALAWISE_EMAIL,
  password = process.env.RALAWISE_PASSWORD,
  workDir,
  onProgress,
} = {}) {
  if (!email || !password) {
    throw new Error(
      'RALAWISE_EMAIL and RALAWISE_PASSWORD are required to refresh download links'
    )
  }

  let chromium
  try {
    ;({ chromium } = require('playwright'))
  } catch {
    throw new Error(
      'Playwright is not installed. Run: npm install playwright && npx playwright install chromium'
    )
  }

  const dir =
    workDir ||
    path.join(process.cwd(), 'tmp', 'ralawise', `run-${Date.now()}`)
  ensureDir(dir)

  await reportProgress(onProgress, {
    step: 'connecting',
    message: 'Connecting to Ralawise…',
  })

  const browser = await launchBrowser(chromium)
  try {
    const context = await browser.newContext({
      userAgent: 'WooApp-RalawiseSync/1.0',
      acceptDownloads: true,
    })
    const page = await context.newPage()
    await loginRalawise(page, email, password)
    const urls = await scrapeDownloadHrefs(page)

    await reportProgress(onProgress, {
      step: 'downloading',
      message: 'Downloading latest catalog ZIPs…',
    })

    const [parentZip, variationsZip] = await Promise.all([
      downloadZipWithContext(context.request, urls.parentUrl, 'products'),
      downloadZipWithContext(context.request, urls.variationsUrl, 'variations'),
    ])

    return {
      ...writeCatalogFromZips({ dir, parentZip, variationsZip }),
      parentUrl: urls.parentUrl,
      variationsUrl: urls.variationsUrl,
      source: 'playwright',
    }
  } finally {
    await browser.close()
  }
}

/** @deprecated use downloadCatalogWithPlaywright for authenticated downloads */
async function scrapeDownloadUrlsWithPlaywright(opts = {}) {
  const catalog = await downloadCatalogWithPlaywright(opts)
  return {
    parentUrl: catalog.parentUrl,
    variationsUrl: catalog.variationsUrl,
    source: 'playwright',
  }
}

/**
 * Resolve URLs for callers that only need links (env if still public).
 */
async function resolveRalawiseDownloadUrls({ forceScrape = false } = {}) {
  const envUrls = getEnvDownloadUrls()

  if (!forceScrape && envUrls.parentUrl && envUrls.variationsUrl) {
    const usable =
      (await isZipUrlUsable(envUrls.parentUrl)) &&
      (await isZipUrlUsable(envUrls.variationsUrl))
    if (usable) {
      return { ...envUrls, source: 'env' }
    }
  }

  if (process.env.RALAWISE_EMAIL && process.env.RALAWISE_PASSWORD) {
    const catalog = await downloadCatalogWithPlaywright()
    return {
      parentUrl: catalog.parentUrl,
      variationsUrl: catalog.variationsUrl,
      source: 'playwright',
      // Attached so import can skip a second download when scrape already fetched
      _catalog: catalog,
    }
  }

  throw new Error(
    'Missing or expired Ralawise download URLs. Set fresh RALAWISE_PARENT_URL / RALAWISE_VARIATIONS_URL, or RALAWISE_EMAIL / RALAWISE_PASSWORD.'
  )
}

/**
 * Preferred entry: try public env URLs, else Playwright authenticated download.
 */
async function fetchRalawiseCatalog({
  workDir,
  forcePlaywright = false,
  onProgress,
} = {}) {
  const envUrls = getEnvDownloadUrls()

  await reportProgress(onProgress, {
    step: 'connecting',
    message: 'Connecting to Ralawise…',
  })

  if (!forcePlaywright && envUrls.parentUrl && envUrls.variationsUrl) {
    try {
      return await downloadCatalog({
        parentUrl: envUrls.parentUrl,
        variationsUrl: envUrls.variationsUrl,
        workDir,
        onProgress,
      })
    } catch (envError) {
      if (!(process.env.RALAWISE_EMAIL && process.env.RALAWISE_PASSWORD)) {
        throw envError
      }
      console.warn(
        'Env Ralawise URLs failed, falling back to Playwright login:',
        envError.message
      )
    }
  }

  return downloadCatalogWithPlaywright({ workDir, onProgress })
}

module.exports = {
  downloadCatalog,
  downloadCatalogWithPlaywright,
  downloadZip,
  extractCsvFromZip,
  getEnvDownloadUrls,
  resolveRalawiseDownloadUrls,
  scrapeDownloadUrlsWithPlaywright,
  fetchRalawiseCatalog,
  isZipUrlUsable,
  PARENT_CSV_NAME,
  VARIATIONS_CSV_NAME,
}
