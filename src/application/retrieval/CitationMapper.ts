/**
 * CitationMapper
 * Strict Application Layer: Zero Node I/O, Zero Infrastructure/Interfaces imports.
 * Maps hydrated chunks to 1:1 citation labels (S1, S2...), verifies URL anchor existence,
 * and escapes Markdown control characters in titles and headings.
 */

import type { SourceRef, DocumentChunk, NormalizedDocument } from '../../domain/models/index.js';

export interface HydratedCandidate {
  chunk: DocumentChunk;
  document: NormalizedDocument | null;
  lastCheckedAt: string;
  rank: number;
}

/**
 * Escapes Markdown special characters to prevent formatting breakage or syntax injection.
 */
export function escapeMarkdown(text: string): string {
  if (!text) return '';
  return text.replace(/([\\`*_{}[\]()#+\-.!|<>])/g, '\\$1');
}

/**
 * Resolves official canonical URL with verified anchor fragment.
 * If chunk has an anchor, verifies whether the anchor exists in document headings.
 * Appends #anchor ONLY if verified; otherwise returns pure canonicalUrl.
 */
export function resolveOfficialUrl(
  canonicalUrl: string,
  anchor: string | undefined,
  document: NormalizedDocument | null,
): string {
  if (!canonicalUrl) return '';
  if (!anchor) return canonicalUrl;

  const cleanAnchor = anchor.replace(/^#/, '');
  if (!cleanAnchor) return canonicalUrl;

  if (document?.headings && document.headings.length > 0) {
    const exists = document.headings.some(
      (h) => h.anchor && h.anchor.replace(/^#/, '') === cleanAnchor,
    );
    if (exists) {
      return `${canonicalUrl}#${cleanAnchor}`;
    }
  }

  return canonicalUrl;
}

/**
 * Maps a hydrated candidate to a SourceRef with 1-based sequential label (S1, S2...).
 */
export function mapCitation(candidate: HydratedCandidate, index: number): SourceRef {
  const label = `S${index + 1}`;
  const canonicalUrl = candidate.document?.canonicalUrl ?? '';
  const finalUrl = resolveOfficialUrl(canonicalUrl, candidate.chunk.anchor, candidate.document);

  return {
    id: label,
    chunkId: candidate.chunk.chunkId,
    documentId: candidate.chunk.documentId,
    snapshotId: candidate.chunk.snapshotId,
    title: candidate.chunk.title,
    url: finalUrl,
    headingPath: candidate.chunk.headingPath,
    lastCheckedAt: candidate.lastCheckedAt,
  };
}

/**
 * Formats the heading line with breadcrumbs, escaping Markdown characters.
 */
export function formatHeadingLine(title: string, headingPath: string[]): string {
  const escapedTitle = escapeMarkdown(title);
  if (!headingPath || headingPath.length === 0) {
    return escapedTitle;
  }
  const escapedHeadings = headingPath.map((h) => escapeMarkdown(h));
  return `${escapedTitle} > ${escapedHeadings.join(' > ')}`;
}

/**
 * Formats a single source reference entry for the ## Sources index.
 */
export function formatSourceIndexEntry(source: SourceRef): string {
  const headingText = formatHeadingLine(source.title, source.headingPath);
  return `- [${source.id}] ${headingText} (${source.url})`;
}

/**
 * Formats the header block for an excerpt section.
 */
export function formatChunkHeader(source: SourceRef): string {
  const headingText = formatHeadingLine(source.title, source.headingPath);
  return `### [${source.id}] ${headingText}\n**Source**: ${source.url}`;
}
