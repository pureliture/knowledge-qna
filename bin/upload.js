#!/usr/bin/env node

/**
 * knowledge-upload
 * Zero-install client-side upload tool for knowledge-qna MinIO storage.
 * Designed for public repositories: ZERO credentials or private IPs are hardcoded.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';

function printHelp() {
  console.log(`
knowledge-upload - 지식 문서 MinIO 업로드 도구

사용법:
  MINIO_ENDPOINT="http://<서버IP>:30900" MINIO_SECRET_KEY="<비밀번호>" \\
    npx github:pureliture/knowledge-qna upload <업로드할_파일_경로>

옵션:
  --endpoint <url>     MinIO 서버 주소 (기본값: MINIO_ENDPOINT 환경변수)
  --access-key <key>   Access Key (기본값: MINIO_ACCESS_KEY 또는 'minioadmin')
  --secret-key <key>   Secret Key (기본값: MINIO_SECRET_KEY 환경변수) [필수]
  --bucket <name>      대상 버킷 이름 (기본값: 'knowledge-docs')
  --target-key <path>  저장 경로 (기본값: 'incoming/<파일명>')
  -h, --help           도움말 출력
`);
}

function hmac(key, string, encoding) {
  return crypto.createHmac('sha256', key).update(string, 'utf8').digest(encoding);
}

function hash(string) {
  return crypto.createHash('sha256').update(string, typeof string === 'string' ? 'utf8' : undefined).digest('hex');
}

function getSignatureKey(key, dateStamp, regionName, serviceName) {
  const kDate = hmac('AWS4' + key, dateStamp);
  const kRegion = hmac(kDate, regionName);
  const kService = hmac(kRegion, serviceName);
  const kSigning = hmac(kService, 'aws4_request');
  return kSigning;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(args.includes('-h') || args.includes('--help') ? 0 : 1);
  }

  // Parse arguments
  let filePath = '';
  let endpoint = process.env.MINIO_ENDPOINT || '';
  let accessKey = process.env.MINIO_ACCESS_KEY || 'minioadmin';
  let secretKey = process.env.MINIO_SECRET_KEY || '';
  let bucket = process.env.MINIO_BUCKET || 'knowledge-docs';
  let targetKey = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--endpoint' && args[i + 1]) endpoint = args[++i];
    else if (arg === '--access-key' && args[i + 1]) accessKey = args[++i];
    else if (arg === '--secret-key' && args[i + 1]) secretKey = args[++i];
    else if (arg === '--bucket' && args[i + 1]) bucket = args[++i];
    else if (arg === '--target-key' && args[i + 1]) targetKey = args[++i];
    else if (!arg.startsWith('-') && !filePath) filePath = arg;
  }

  if (!filePath) {
    console.error('[Error] 업로드할 파일 경로를 지정해 주세요.');
    printHelp();
    process.exit(1);
  }

  const resolvedPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    console.error(`[Error] 파일을 찾을 수 없습니다: ${resolvedPath}`);
    process.exit(1);
  }

  if (!endpoint) {
    console.error('[Error] MinIO 서버 주소가 지정되지 않았습니다.');
    console.error('        --endpoint 옵션이나 MINIO_ENDPOINT 환경변수를 설정해 주세요.');
    process.exit(1);
  }

  if (!secretKey) {
    console.error('[Error] MinIO Secret Key가 지정되지 않았습니다.');
    console.error('        --secret-key 옵션이나 MINIO_SECRET_KEY 환경변수를 설정해 주세요.');
    process.exit(1);
  }

  const fileName = path.basename(resolvedPath);
  if (!targetKey) {
    targetKey = `incoming/${fileName}`;
  }

  const fileBuffer = fs.readFileSync(resolvedPath);
  const fileSize = fileBuffer.length;
  const payloadHash = hash(fileBuffer);

  // Parse endpoint URL
  if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
    endpoint = 'http://' + endpoint;
  }
  const urlObj = new URL(endpoint);
  const host = urlObj.host;
  const isHttps = urlObj.protocol === 'https:';

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const region = 'us-east-1';
  const service = 's3';

  const canonicalUri = `/${bucket}/${targetKey}`;
  const canonicalQuery = '';
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = `PUT\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${hash(canonicalRequest)}`;

  const signingKey = getSignatureKey(secretKey, dateStamp, region, service);
  const signature = hmac(signingKey, stringToSign, 'hex');

  const authorizationHeader = `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  console.log(`[*] 파일 업로드 시작: ${fileName} (${fileSize.toLocaleString()} bytes)`);
  console.log(`    -> 대상: s3://${bucket}/${targetKey}`);

  const reqOptions = {
    method: 'PUT',
    hostname: urlObj.hostname,
    port: urlObj.port || (isHttps ? 443 : 80),
    path: canonicalUri,
    headers: {
      'Host': host,
      'Content-Length': fileSize,
      'Content-Type': 'application/octet-stream',
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      'Authorization': authorizationHeader,
    },
  };

  const client = isHttps ? https : http;

  const req = client.request(reqOptions, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log(`[ok] 업로드 성공! s3://${bucket}/${targetKey}`);
        console.log(`[*] k3s CronJob이 자동으로 감지하여 GCP로 색인을 진행합니다.`);
      } else {
        console.error(`[Error] 업로드 실패 (HTTP ${res.statusCode}): ${body}`);
        process.exit(1);
      }
    });
  });

  req.on('error', (err) => {
    console.error(`[Error] 네트워크 통신 오류: ${err.message}`);
    process.exit(1);
  });

  req.write(fileBuffer);
  req.end();
}

main().catch((err) => {
  console.error('[Error]', err);
  process.exit(1);
});
