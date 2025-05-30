FROM public.ecr.aws/lambda/nodejs:22 AS builder
WORKDIR /build
COPY package*.json ./
COPY packages/agent-core/package*.json ./packages/agent-core/
COPY packages/webapp/package*.json ./packages/webapp/
RUN --mount=type=cache,target=/root/.npm npm ci
COPY ./ ./
RUN cd packages/agent-core && npm run build
RUN cd packages/webapp && npx esbuild src/jobs/*.ts --bundle --outdir=dist --platform=node --charset=utf8

FROM public.ecr.aws/lambda/nodejs:22 AS runner

COPY package*.json ./
COPY packages/agent-core/package*.json ./packages/agent-core/
COPY packages/webapp/package*.json ./packages/webapp/
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
COPY --from=builder /build/packages/webapp/dist/. ./

CMD ["async-job-runner.handler"]
