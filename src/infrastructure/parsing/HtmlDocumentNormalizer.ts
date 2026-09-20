/**
 * HtmlDocumentNormalizer
 * Infrastructure implementation of DocumentNormalizer port using Cheerio and Turndown with GFM.
 * Strict Layer Boundary: Infrastructure imports only domain and application/ports.
 */

import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import type {
  DocumentNormalizer,
  NormalizeInput,
} from '../../application/ports/DocumentNormalizer.js';
import type {
  NormalizedDocument,
  DocumentHeading,
  DocumentMetadata,
} from '../../domain/models/index.js';
import {
  computeDocumentId,
  computeNormalizedHash,
  computeSnapshotId,
} from '../../domain/identity.js';
import { CliOperationError } from '../../domain/errors.js';
import { OpenApiNormalizer } from './OpenApiNormalizer.js';

export class HtmlDocumentNormalizer implements DocumentNormalizer {
  readonly profileId: string;
  private readonly openApiNormalizer: OpenApiNormalizer;

  constructor(profileId: string = 'html-normalizer-v1') {
    this.profileId = profileId;
    this.openApiNormalizer = new OpenApiNormalizer('openapi-normalizer-v1');
  }

  async normalizeMany(input: NormalizeInput): Promise<NormalizedDocument[]> {
    const trimmed = input.html.trim();
    if (trimmed.startsWith('{') && (trimmed.includes('"openapi"') || trimmed.includes('"paths"'))) {
      return this.openApiNormalizer.normalizeSpec({
        libraryId: input.libraryId,
        versionKey: input.versionKey,
        specUrl: input.canonicalUrl,
        jsonContent: input.html,
      });
    }
    return [await this.normalize(input)];
  }

  async normalize(input: NormalizeInput): Promise<NormalizedDocument> {
    if (!input.html || input.html.trim().length === 0) {
      throw new CliOperationError({
        code: 'DOCUMENT_PARSE_FAILED',
        message: `HTML content is empty for URL '${input.canonicalUrl}'`,
      });
    }

    const $ = cheerio.load(input.html);

    // 1. Remove noise elements based on removeSelectors
    if (input.parserConfig.removeSelectors && input.parserConfig.removeSelectors.length > 0) {
      for (const selector of input.parserConfig.removeSelectors) {
        if (selector && selector.trim()) {
          $(selector).remove();
        }
      }
    }

    // Always remove non-content script/style/noscript/iframe and comments
    $('script, style, noscript, iframe').remove();
    $('*')
      .contents()
      .filter((_, el) => el.type === 'comment')
      .remove();

    // 2. Select content container using contentSelectors in declared order (first non-empty match wins)
    let container: ReturnType<typeof $> | null = null;
    if (input.parserConfig.contentSelectors && input.parserConfig.contentSelectors.length > 0) {
      for (const selector of input.parserConfig.contentSelectors) {
        if (!selector || !selector.trim()) continue;
        const match = $(selector);
        if (match.length > 0) {
          const text = match.first().text().trim();
          if (text.length > 0) {
            container = match.first();
            break; // Stop immediately to prevent nested duplicate extraction
          }
        }
      }
    }

    // Fallback to <body> if no selector matched or contentSelectors was empty
    if (!container || container.text().trim().length === 0) {
      const body = $('body');
      if (body.length > 0 && body.text().trim().length > 0) {
        container = body;
      }
    }

    if (!container || container.text().trim().length === 0) {
      throw new CliOperationError({
        code: 'DOCUMENT_PARSE_FAILED',
        message: `No content found matching contentSelectors for URL '${input.canonicalUrl}'`,
      });
    }

    // 3. Relative URL resolution to absolute URL based on canonicalUrl
    container.find('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (href) {
        const trimmed = href.trim();
        if (
          !trimmed.startsWith('#') &&
          !trimmed.startsWith('mailto:') &&
          !trimmed.startsWith('javascript:') &&
          !trimmed.startsWith('tel:') &&
          !trimmed.startsWith('data:')
        ) {
          try {
            const absolute = new URL(trimmed, input.canonicalUrl).toString();
            $(el).attr('href', absolute);
          } catch {
            // Leave unchanged on invalid relative URL
          }
        }
      }
    });

    container.find('img[src]').each((_, el) => {
      const src = $(el).attr('src');
      if (src) {
        const trimmed = src.trim();
        if (
          !trimmed.startsWith('data:') &&
          !trimmed.startsWith('http://') &&
          !trimmed.startsWith('https://')
        ) {
          try {
            const absolute = new URL(trimmed, input.canonicalUrl).toString();
            $(el).attr('src', absolute);
          } catch {
            // Leave unchanged
          }
        }
      }
    });

    // 4. Code block language normalization and fence preservation
    container.find('pre').each((_, preEl) => {
      const $pre = $(preEl);
      let $code = $pre.find('code').first();
      if ($code.length === 0) {
        const innerHtml = $pre.html() ?? '';
        $pre.html(`<code>${innerHtml}</code>`);
        $code = $pre.find('code').first();
      }

      let lang = '';
      const preClass = $pre.attr('class') ?? '';
      const codeClass = $code.attr('class') ?? '';
      const preDataLang = $pre.attr('data-lang') ?? $pre.attr('data-language') ?? '';
      const codeDataLang = $code.attr('data-lang') ?? $code.attr('data-language') ?? '';

      const langMatch = `${preClass} ${codeClass}`.match(
        /(?:language-|lang-|highlight-source-|highlight-)([a-zA-Z0-9_+-]+)/i,
      );

      if (langMatch && langMatch[1]) {
        lang = langMatch[1].toLowerCase();
      } else if (codeDataLang) {
        lang = codeDataLang.toLowerCase();
      } else if (preDataLang) {
        lang = preDataLang.toLowerCase();
      }

      if (lang) {
        $code.addClass(`language-${lang}`);
      }
    });

    // 5. Headings and title extraction
    const headings: DocumentHeading[] = [];
    container.find('h1, h2, h3, h4, h5, h6').each((_, headingEl) => {
      const $h = $(headingEl);
      const tag = headingEl.tagName.toLowerCase();
      const level = parseInt(tag.slice(1), 10);
      const text = $h.text().trim();
      if (!text) return;

      // Genuine anchor only: id or name attribute on the heading or immediate child anchor
      let anchor: string | undefined = undefined;
      const idAttr = $h.attr('id')?.trim();
      const nameAttr = $h.attr('name')?.trim();
      if (idAttr) {
        anchor = idAttr;
      } else if (nameAttr) {
        anchor = nameAttr;
      } else {
        const childAnchor = $h.find('a[id], a[name]').first();
        if (childAnchor.length > 0) {
          anchor = childAnchor.attr('id')?.trim() || childAnchor.attr('name')?.trim() || undefined;
        }
      }

      headings.push({
        level,
        text,
        ...(anchor ? { anchor } : {}),
      });
    });

    // Determine document title: first h1 in container, else <title>, else first heading, else URL path
    const firstH1 = headings.find((h) => h.level === 1);
    const docTitle = $('title').text().trim();
    const firstHeading = headings[0];

    let title = firstH1?.text;
    if (!title && docTitle) {
      title = docTitle;
    }
    if (!title && firstHeading) {
      title = firstHeading.text;
    }
    if (!title) {
      try {
        const parsed = new URL(input.canonicalUrl);
        title = parsed.pathname.split('/').filter(Boolean).pop() || input.canonicalUrl;
      } catch {
        title = input.canonicalUrl;
      }
    }

    // 6. Metadata extraction
    const docLang =
      $('html').attr('lang')?.trim() ||
      $('meta[name="language"]').attr('content')?.trim() ||
      $('meta[property="og:locale"]').attr('content')?.trim() ||
      undefined;

    const metadata: DocumentMetadata = {};
    if (docLang) {
      metadata.language = docLang;
    }

    // 7. Turndown Markdown conversion with GFM tables
    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      fence: '```',
      emDelimiter: '_',
    });
    turndown.use(gfm);

    const containerHtml = container.html() ?? '';
    let markdown = turndown.turndown(containerHtml);

    // Clean up excessive newlines
    markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();

    // 8. Deterministic identity computation
    const documentId = computeDocumentId(input.libraryId, input.versionKey, input.canonicalUrl);
    const normalizedHash = computeNormalizedHash({
      title,
      markdown,
      headings,
      metadata,
    });
    const snapshotId = computeSnapshotId(documentId, input.normalizerProfileId, normalizedHash);

    return {
      schemaVersion: 1,
      documentId,
      snapshotId,
      libraryId: input.libraryId,
      versionKey: input.versionKey,
      canonicalUrl: input.canonicalUrl,
      title,
      markdown,
      headings,
      normalizedHash,
      normalizerProfileId: input.normalizerProfileId,
      metadata,
    };
  }
}
