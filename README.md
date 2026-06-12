# Cloudflare Workers Secure Proxy Guide

This guide explains how to set up, deploy, and use a secure proxy on Cloudflare Workers using the provided code in src/index.js. 

## How the Proxy Works

The proxy acts as an intermediary between your application and a target website. Here is what it does:

1. **Handles CORS (Cross-Origin Resource Sharing)**: Allows requests from any frontend website, handling CORS preflight checks (OPTIONS requests) automatically.
2. **Secures with Basic Authentication**: Requires a username and password to prevent unauthorized usage. It checks the request headers against two environment variables: PROXY_USER and PROXY_SECRET.
3. **Extracts Target URL**: Finds the website you want to proxy. You can specify it using the target query parameter in the URL (for example: https://your-worker.workers.dev/?target=https://example.com) or via the X-Proxy-Target header.
4. **Sanitizes Headers**: Removes headers that identify the request is coming from a proxy (like Host, Referer, and Cloudflare tracking headers) and injects standard modern browser headers (like User-Agent) to bypass basic scraping blocks.
5. **Fetches Upstream**: Sends the sanitized request to the target site.
6. **Rewrites HTML Links**: If the target site returns HTML content, the proxy automatically updates tags (a, img, script, link, form, iframe) so that links clicked and resources loaded also route through the proxy.

---

## Step-by-Step Setup Guide

### 1. Prerequisites
You need the following installed on your computer:
* Node.js (version 18 or higher is recommended)

### 2. Project Structure
Ensure your project files are arranged as follows:
* package.json - Contains project scripts and developer tools.
* wrangler.toml - Configuration file for your Cloudflare Worker.
* src/index.js - The main proxy logic.

### 3. Install Dependencies
Open your terminal in the project directory and run:
```bash
npm install
```
This installs wrangler, the CLI tool used to test and deploy Cloudflare Workers.

### 4. Running Locally
To test the proxy locally, run:
```bash
npm run dev
```
By default, this will start a local server, usually at http://localhost:8787.

To test authentication and target fetching locally, you can create a file named `.dev.vars` in the root of the project to set local environment variables:
```text
PROXY_USER=myusername
PROXY_SECRET=mypassword
```
Save that file, restart your local server, and you can test authentication.

---

## Deploying to Cloudflare

### 1. Log in to Cloudflare
In your terminal, log in to your Cloudflare account by running:
```bash
npx wrangler login
```
A browser window will open asking you to authorize Wrangler.

### 2. Configure Environment Variables
You must set the username and password values that the worker will use to authorize requests. Run the following commands:

For the username:
```bash
npx wrangler secret put PROXY_USER
```
You will be prompted to enter the username. Enter your chosen username.

For the password:
```bash
npx wrangler secret put PROXY_SECRET
```
You will be prompted to enter the password/secret. Enter your chosen password.

### 3. Deploy the Worker
Deploy the worker to your Cloudflare account by running:
```bash
npm run deploy
```
Once completed, the command output will display the URL of your deployed Worker (for example: https://workers2.your-subdomain.workers.dev).

---

## How to Use the Proxy

To make a request through the proxy, you must provide:
1. The target URL either as a query parameter (?target=...) or via the X-Proxy-Target header.
2. The HTTP Basic Authentication header containing your username and password.

### Example Using Curl
Replace myusername, mypassword, and the Worker URL with your credentials and domain:

```bash
curl -u "myusername:mypassword" "https://workers2.your-subdomain.workers.dev/?target=https://icanhazip.com"
```

### Example Using Javascript Fetch
```javascript
const username = 'myusername';
const password = 'mypassword';
const workerUrl = 'https://workers2.your-subdomain.workers.dev';
const targetUrl = 'https://icanhazip.com';

// Encode credentials to base64 for Basic Auth
const credentials = btoa(`${username}:${password}`);

fetch(`${workerUrl}/?target=${encodeURIComponent(targetUrl)}`, {
  headers: {
    'Authorization': `Basic ${credentials}`
  }
})
.then(response => response.text())
.then(data => console.log(data))
.catch(error => console.error('Error:', error));
```
