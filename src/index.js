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
        const requestOrigin = request.headers.get('Origin') || '*';

        // Helper to return responses with standard CORS headers
        const corsHeaders = {
            'Access-Control-Allow-Origin': requestOrigin,
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
            'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || 'Authorization, Content-Type, X-Proxy-Target, *',
            'Access-Control-Max-Age': '86400',
        };
        if (requestOrigin !== '*') {
            corsHeaders['Access-Control-Allow-Credentials'] = 'true';
        }

        const errorResponse = (body, status) => {
            return new Response(body, {
                status: status,
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'text/plain'
                }
            });
        };

        // 1. CORS Preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: corsHeaders
            });
        }

        // 2. Fast-Fail HTTP Basic Auth Check
        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Basic ')) {
            return new Response('Unauthorized', {
                status: 401,
                headers: {
                    'WWW-Authenticate': 'Basic realm="Secure Proxy"',
                    ...corsHeaders
                }
            });
        }

        let user = '', password = '';
        try {
            const base64Credentials = authHeader.split(' ')[1];
            [user, password] = atob(base64Credentials).split(':');
        } catch (e) {
            return errorResponse('Bad Request: Invalid credentials format', 400);
        }

        const isUserValid = await secureCompare(user, env.PROXY_USER);
        const isPassValid = await secureCompare(password, env.PROXY_SECRET);
        if (!isUserValid || !isPassValid) {
            return errorResponse('Forbidden: Invalid credentials', 403);
        }

        const url = new URL(request.url);

        // 3. Target URL Extraction
        let targetUrlStr = url.searchParams.get('target') || request.headers.get('X-Proxy-Target');
        if (!targetUrlStr) {
            return errorResponse('Bad Request: Missing target', 400);
        }

        // Unwrap nested/loopback proxy URLs to prevent loopback request duplication and latency
        try {
            let nestedUrl = new URL(targetUrlStr);
            while (nestedUrl.hostname === url.hostname && nestedUrl.searchParams.has('target')) {
                const unwrapped = nestedUrl.searchParams.get('target');
                if (unwrapped) {
                    targetUrlStr = unwrapped;
                    nestedUrl = new URL(targetUrlStr);
                } else {
                    break;
                }
            }
        } catch (e) {
            // Keep targetUrlStr as is if parsing fails
        }

        let targetUrl;
        try {
            targetUrl = new URL(targetUrlStr);
        } catch (e) {
            return errorResponse('Bad Request: Invalid target URL', 400);
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

            // Copy dynamic CORS headers
            for (const [key, value] of Object.entries(corsHeaders)) {
                resHeaders.set(key, value);
            }

            resHeaders.set('Access-Control-Expose-Headers', '*');
            resHeaders.delete('Content-Security-Policy');
            resHeaders.delete('X-Frame-Options');
            resHeaders.delete('Strict-Transport-Security');

            // Strip encoding/length headers since Cloudflare automatically handles decompression
            resHeaders.delete('Content-Encoding');
            resHeaders.delete('Content-Length');

            // Determine if rewriting is requested
            const shouldRewrite = url.searchParams.get('rewrite') === 'true' || request.headers.get('X-Rewrite-HTML') === 'true';

            // Handle manual redirects
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const location = resHeaders.get('Location');
                if (location) {
                    try {
                        const absoluteLocation = new URL(location, targetUrl.origin).toString();
                        if (shouldRewrite) {
                            const rewrittenLocation = `${url.origin}/?target=${encodeURIComponent(absoluteLocation)}&rewrite=true`;
                            resHeaders.set('Location', rewrittenLocation);
                        } else {
                            resHeaders.set('Location', absoluteLocation);
                        }
                    } catch (e) { }
                }
            }

            const contentType = resHeaders.get('Content-Type') || '';

            // 6. Dynamic HTML Rewriting (optional, enabled via 'rewrite' query param or 'X-Rewrite-HTML' header)
            if (shouldRewrite && contentType.includes('text/html')) {
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
            return errorResponse(`Internal Server Error: ${e.message}`, 500);
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
                const rewrittenUrl = `${this.proxyOrigin}/?target=${encodeURIComponent(absoluteUrl)}&rewrite=true`;
                element.setAttribute(this.attributeName, rewrittenUrl);
            } catch (e) { }
        }
    }
}
