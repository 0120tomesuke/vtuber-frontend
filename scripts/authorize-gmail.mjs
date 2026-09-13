import http from 'node:http';
import { randomBytes } from 'node:crypto';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} を一時環境変数として設定してください。`);
  return value;
};

const clientId = required('GMAIL_OAUTH_CLIENT_ID');
const clientSecret = required('GMAIL_OAUTH_CLIENT_SECRET');
const redirectUri = process.env.GMAIL_OAUTH_REDIRECT_URI || 'http://localhost:8788/oauth2callback';
const redirect = new URL(redirectUri);
const state = randomBytes(24).toString('hex');

if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(redirect.hostname)) {
  throw new Error('GMAIL_OAUTH_REDIRECT_URI は http://localhost のローカルURLにしてください。');
}

const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authorization.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: 'https://www.googleapis.com/auth/gmail.send',
  access_type: 'offline',
  prompt: 'consent',
  state
}).toString();

const server = http.createServer(async (request, response) => {
  const received = new URL(request.url || '/', redirectUri);
  if (received.pathname !== redirect.pathname) {
    response.writeHead(404).end('Not found');
    return;
  }
  if (received.searchParams.get('state') !== state || !received.searchParams.get('code')) {
    response.writeHead(400).end('Authorization failed. Return to the terminal and try again.');
    server.close();
    return;
  }
  try {
    const body = new URLSearchParams({
      code: received.searchParams.get('code'),
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    });
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    });
    const detail = await tokenResponse.text();
    if (!tokenResponse.ok) throw new Error(`Google token exchange failed: ${tokenResponse.status} ${detail}`);
    const token = JSON.parse(detail).refresh_token;
    if (!token) throw new Error('更新トークンが返りませんでした。Googleの同意画面で許可を取り消してから、もう一度実行してください。');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<h1>認可完了</h1><p>このタブを閉じ、ターミナルに表示された更新トークンをCloudflare Secretへ登録してください。</p>');
    console.log('\nGMAIL_OAUTH_REFRESH_TOKEN:');
    console.log(token);
    console.log('\nこの値は秘密情報です。CloudflareのSecretにだけ登録し、GitHubへ保存しないでください。');
  } catch (error) {
    response.writeHead(500).end('Token exchange failed. Check the terminal.');
    console.error(error);
  } finally {
    server.close();
  }
});

server.listen(Number(redirect.port || 80), redirect.hostname, () => {
  console.log('\n次のURLをブラウザで開き、Gmail送信を許可してください。');
  console.log(authorization.toString());
  console.log('\n認可後、このターミナルに更新トークンが1回だけ表示されます。');
});
