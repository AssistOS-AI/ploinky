import http from 'node:http';

const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`http-router-service-ok ${request.url}`);
});

server.listen(7000, '0.0.0.0');
