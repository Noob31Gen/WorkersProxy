async function secureCompare(a, b) {
    if (!a || !b) return false;
    const enc = new TextEncoder();
    const aBuf = enc.encode(a);
    const bBuf = enc.encode(b);
    if (aBuf.byteLength !== bBuf.byteLength) return false;
    let result = 0;
    for (let i = 0; i < aBuf.byteLength; i++) {
        result |= aBuf[i] ^ bBuf[i];
    }
    return result === 0;
}

export default {
    async fetch(request, env) {
        // 1. CORS Preflight
        const requestOrigin = request.headers.get('Origin') || '*';

        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': requestOrigin,
                    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
                    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Proxy-Target, *',
                    'Access-Control-Allow-Credentials': 'true',
                    'Access-Control-Max-Age': '86400',
                }
            });
        }

        // 2. Fast-Fail HTTP Basic Auth Check
        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Basic ')) {
            return new Response('Unauthorized', {
                status: 401,
                headers: { 'WWW-Authenticate': 'Basic realm="Secure Proxy"' }
            });
        }

        let user = '', password = '';
        try {
            const base64Credentials = authHeader.split(' ')[1];
            [user, password] = atob(base64Credentials).split(':');
        } catch (e) {
            return new Response('Bad Request', { status: 400 });
        }

        const isUserValid = await secureCompare(user, env.PROXY_USER);
        const isPassValid = await secureCompare(password, env.PROXY_SECRET);
        if (!isUserValid || !isPassValid) {
            return new Response('Forbidden: Invalid credentials', { status: 403 });
        }

        const url = new URL(request.url);

        // 3. Target URL Extraction
        const targetUrlStr = url.searchParams.get('target') || request.headers.get('X-Proxy-Target');
        if (!targetUrlStr) {
            return new Response('Bad Request: Missing target', { status: 400 });
        }

        let targetUrl;
        try {
            targetUrl = new URL(targetUrlStr);
        } catch (e) {
            return new Response('Bad Request: Invalid target', { status: 400 });
        }

        targetUrl.username = '';
        targetUrl.password = '';

        // 4. Header Sanitization
        const headers = new Headers(request.headers);

        headers.delete('Authorization');
        headers.delete('X-Proxy-Target');

        // Strip standard reverse proxy and Cloudflare tracing headers
        const headersToStrip = [
            'Host', 'Origin', 'Referer',
            'X-Forwarded-For', 'X-Forwarded-Proto', 'X-Forwarded-Host',
            'X-Real-Ip', 'True-Client-Ip',
            'Cf-Connecting-Ip', 'Cf-Visitor', 'Cf-Ray', 'Cf-Ipcountry', 'Cdn-Loop'
        ];
        headersToStrip.forEach(h => headers.delete(h));

        // Inject fallback modern browser headers
        if (!headers.has('User-Agent')) headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        if (!headers.has('Accept')) headers.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7');
        if (!headers.has('Accept-Language')) headers.set('Accept-Language', 'en-US,en;q=0.9');
        if (!headers.has('Sec-Ch-Ua')) {
            headers.set('Sec-Ch-Ua', '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"');
            headers.set('Sec-Ch-Ua-Mobile', '?0');
            headers.set('Sec-Ch-Ua-Platform', '"Windows"');
        }
        if (!headers.has('Sec-Fetch-Dest')) headers.set('Sec-Fetch-Dest', 'document');
        if (!headers.has('Sec-Fetch-Mode')) headers.set('Sec-Fetch-Mode', 'navigate');
        if (!headers.has('Sec-Fetch-Site')) headers.set('Sec-Fetch-Site', 'none');
        if (!headers.has('Sec-Fetch-User')) headers.set('Sec-Fetch-User', '?1');
        if (!headers.has('Upgrade-Insecure-Requests')) headers.set('Upgrade-Insecure-Requests', '1');

        try {
            // 5. Execute Upstream Fetch
            const response = await fetch(targetUrl.toString(), {
                method: request.method,
                headers: headers,
                body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
                redirect: 'manual'
            });

            const resHeaders = new Headers(response.headers);

            resHeaders.set('Access-Control-Allow-Origin', requestOrigin);

            if (requestOrigin !== '*') {
                resHeaders.set('Access-Control-Allow-Credentials', 'true');
            }

            resHeaders.set('Access-Control-Expose-Headers', '*');
            resHeaders.delete('Content-Security-Policy');
            resHeaders.delete('X-Frame-Options');
            resHeaders.delete('Strict-Transport-Security');

            // Handle manual redirects
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const location = resHeaders.get('Location');
                if (location) {
                    try {
                        const absoluteLocation = new URL(location, targetUrl.origin).toString();
                        const rewrittenLocation = `${url.origin}/?target=${encodeURIComponent(absoluteLocation)}`;
                        resHeaders.set('Location', rewrittenLocation);
                    } catch (e) { }
                }
            }

            const contentType = resHeaders.get('Content-Type') || '';

            // 6. Dynamic HTML Rewriting
            if (contentType.includes('text/html')) {
                const rewriter = new HTMLRewriter()
                    .on('a', new AttributeRewriter('href', url.origin, targetUrl.origin))
                    .on('img', new AttributeRewriter('src', url.origin, targetUrl.origin))
                    .on('script', new AttributeRewriter('src', url.origin, targetUrl.origin))
                    .on('link', new AttributeRewriter('href', url.origin, targetUrl.origin))
                    .on('form', new AttributeRewriter('action', url.origin, targetUrl.origin))
                    .on('iframe', new AttributeRewriter('src', url.origin, targetUrl.origin));

                return new Response(rewriter.transform(response).body, {
                    status: response.status,
                    headers: resHeaders
                });
            }

            return new Response(response.body, {
                status: response.status,
                headers: resHeaders
            });

        } catch (e) {
            return new Response('Internal Server Error', { status: 500 });
        }
    }
};

class AttributeRewriter {
    constructor(attributeName, proxyOrigin, targetOrigin) {
        this.attributeName = attributeName;
        this.proxyOrigin = proxyOrigin;
        this.targetOrigin = targetOrigin;
    }

    element(element) {
        if (element.hasAttribute('integrity')) {
            element.removeAttribute('integrity');
        }

        const attribute = element.getAttribute(this.attributeName);
        if (attribute) {
            try {
                const absoluteUrl = new URL(attribute, this.targetOrigin).toString();
                const rewrittenUrl = `${this.proxyOrigin}/?target=${encodeURIComponent(absoluteUrl)}`;
                element.setAttribute(this.attributeName, rewrittenUrl);
            } catch (e) { }
        }
    }
}
