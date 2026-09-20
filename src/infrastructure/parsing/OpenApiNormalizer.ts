/**
 * OpenApiNormalizer
 * Normalizes OpenAPI 3.x specification JSON into structured, per-endpoint NormalizedDocument records.
 *
 * Strict Layer Boundary: Infrastructure imports only domain and application/ports.
 */

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

export interface OpenApiNormalizationInput {
  libraryId: string;
  versionKey: string;
  specUrl: string;
  jsonContent: string;
}

export class OpenApiNormalizer {
  readonly profileId: string;

  constructor(profileId: string = 'openapi-normalizer-v1') {
    this.profileId = profileId;
  }

  /**
   * Parses an OpenAPI 3.x JSON document and generates an array of NormalizedDocuments,
   * with each API endpoint represented as an independent, search-optimized Markdown document.
   */
  normalizeSpec(input: OpenApiNormalizationInput): NormalizedDocument[] {
    let spec: any;
    try {
      spec = JSON.parse(input.jsonContent);
    } catch (err) {
      throw new CliOperationError({
        code: 'DOCUMENT_PARSE_FAILED',
        message: `Failed to parse OpenAPI JSON from '${input.specUrl}': ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (!spec || typeof spec !== 'object' || !spec.openapi || !spec.paths) {
      throw new CliOperationError({
        code: 'DOCUMENT_PARSE_FAILED',
        message: `Invalid OpenAPI specification from '${input.specUrl}': missing 'openapi' or 'paths'.`,
      });
    }

    const apiTitle = spec.info?.title || 'OpenAPI Specification';
    const apiVersion = spec.info?.version || input.versionKey;
    const documents: NormalizedDocument[] = [];

    const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'];

    for (const [pathKey, pathItem] of Object.entries<any>(spec.paths)) {
      if (!pathItem || typeof pathItem !== 'object') continue;

      for (const method of HTTP_METHODS) {
        const operation = pathItem[method];
        if (!operation || typeof operation !== 'object') continue;

        const uppercaseMethod = method.toUpperCase();
        const summary = operation.summary || operation.operationId || `${uppercaseMethod} ${pathKey}`;
        const tags = Array.isArray(operation.tags) && operation.tags.length > 0 ? operation.tags[0] : 'General';
        const docTitle = `[${tags}] ${summary} (${uppercaseMethod} ${pathKey})`;

        // Construct canonical URL with fragment identifying this specific endpoint
        const endpointUrl = `${input.specUrl}#/${tags}/${method}${pathKey}`;

        // Build Markdown sections
        const markdownLines: string[] = [];
        const headings: DocumentHeading[] = [];

        // H1 Title
        markdownLines.push(`# ${docTitle}`);
        markdownLines.push('');
        headings.push({ level: 1, text: docTitle, anchor: 'title' });

        markdownLines.push(`**API**: ${apiTitle} (v${apiVersion})`);
        markdownLines.push(`**메서드 및 경로**: \`${uppercaseMethod} ${pathKey}\``);
        markdownLines.push(`**분류(Tag)**: ${tags}`);
        markdownLines.push('');

        // Description
        if (operation.description) {
          markdownLines.push('## 기능 설명');
          markdownLines.push('');
          markdownLines.push(operation.description.trim());
          markdownLines.push('');
          headings.push({ level: 2, text: '기능 설명', anchor: 'description' });
        }

        // Security / Auth
        const security = operation.security || spec.security;
        if (security && Array.isArray(security) && security.length > 0) {
          markdownLines.push('## 인증 및 보안');
          markdownLines.push('');
          for (const sec of security) {
            for (const secKey of Object.keys(sec)) {
              markdownLines.push(`- **인증 방식**: \`${secKey}\``);
            }
          }
          markdownLines.push('');
          headings.push({ level: 2, text: '인증 및 보안', anchor: 'security' });
        }

        // Parameters
        const parameters = operation.parameters || pathItem.parameters || [];
        if (Array.isArray(parameters) && parameters.length > 0) {
          markdownLines.push('## 요청 파라미터');
          markdownLines.push('');
          markdownLines.push('| 이름 | 위치 | 필수 여부 | 타입 | 설명 |');
          markdownLines.push('|---|---|---|---|---|');
          for (const p of parameters) {
            const name = p.name || '-';
            const inPlace = p.in || 'query';
            const required = p.required ? '필수' : '선택';
            const type = p.schema?.type || p.type || 'string';
            const desc = (p.description || '-').replace(/\n/g, ' ').replace(/\|/g, '\\|');
            markdownLines.push(`| \`${name}\` | ${inPlace} | ${required} | \`${type}\` | ${desc} |`);
          }
          markdownLines.push('');
          headings.push({ level: 2, text: '요청 파라미터', anchor: 'parameters' });
        }

        // Request Body
        if (operation.requestBody) {
          markdownLines.push('## 요청 본문 (Request Body)');
          markdownLines.push('');
          if (operation.requestBody.description) {
            markdownLines.push(operation.requestBody.description.trim());
            markdownLines.push('');
          }
          const contentObj = operation.requestBody.content;
          if (contentObj && typeof contentObj === 'object') {
            for (const [contentType, mediaType] of Object.entries<any>(contentObj)) {
              markdownLines.push(`- **Content-Type**: \`${contentType}\``);
              const schema = mediaType.schema;
              if (schema && schema.properties) {
                markdownLines.push('');
                markdownLines.push('| 필드명 | 타입 | 필수 여부 | 설명 |');
                markdownLines.push('|---|---|---|---|');
                const requiredFields = Array.isArray(schema.required) ? schema.required : [];
                for (const [propName, propDef] of Object.entries<any>(schema.properties)) {
                  const isReq = requiredFields.includes(propName) ? '필수' : '선택';
                  const propType = propDef.type || 'any';
                  const propDesc = (propDef.description || '-').replace(/\n/g, ' ').replace(/\|/g, '\\|');
                  markdownLines.push(`| \`${propName}\` | \`${propType}\` | ${isReq} | ${propDesc} |`);
                }
              }
            }
          }
          markdownLines.push('');
          headings.push({ level: 2, text: '요청 본문', anchor: 'request-body' });
        }

        // Responses
        if (operation.responses && typeof operation.responses === 'object') {
          markdownLines.push('## 응답 결과');
          markdownLines.push('');
          for (const [statusCode, respObj] of Object.entries<any>(operation.responses)) {
            const respDesc = respObj.description ? `: ${respObj.description.trim()}` : '';
            markdownLines.push(`### HTTP ${statusCode}${respDesc}`);
            markdownLines.push('');
            const content = respObj.content;
            if (content && typeof content === 'object') {
              for (const [cType, media] of Object.entries<any>(content)) {
                markdownLines.push(`- **Content-Type**: \`${cType}\``);
                if (media.schema && media.schema.properties) {
                  markdownLines.push('');
                  markdownLines.push('| 필드명 | 타입 | 설명 |');
                  markdownLines.push('|---|---|---|');
                  for (const [pName, pDef] of Object.entries<any>(media.schema.properties)) {
                    const pType = pDef.type || 'any';
                    const pDesc = (pDef.description || '-').replace(/\n/g, ' ').replace(/\|/g, '\\|');
                    markdownLines.push(`| \`${pName}\` | \`${pType}\` | ${pDesc} |`);
                  }
                  markdownLines.push('');
                }
              }
            }
          }
          headings.push({ level: 2, text: '응답 결과', anchor: 'responses' });
        }

        const fullMarkdown = markdownLines.join('\n');
        const metadata: DocumentMetadata = {
          language: 'ko',
          docType: 'api-reference',
        };

        const normalizedHash = computeNormalizedHash({
          title: docTitle,
          markdown: fullMarkdown,
          headings,
          metadata,
        });

        const documentId = computeDocumentId(input.libraryId, input.versionKey, endpointUrl);
        const snapshotId = computeSnapshotId(documentId, this.profileId, normalizedHash);

        documents.push({
          schemaVersion: 1,
          documentId,
          snapshotId,
          libraryId: input.libraryId,
          versionKey: input.versionKey,
          canonicalUrl: endpointUrl,
          title: docTitle,
          markdown: fullMarkdown,
          headings,
          normalizedHash,
          normalizerProfileId: this.profileId,
          metadata,
        });
      }
    }

    return documents;
  }
}
