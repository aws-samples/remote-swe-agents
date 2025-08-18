FROM public.ecr.aws/ubuntu/ubuntu:noble

RUN apt-get update && apt-get install -y
RUN apt-get install -y curl

RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash
ENV NODE_VERSION=22.18.0
ENV NVM_DIR=/root/.nvm
RUN . "$NVM_DIR/nvm.sh" && nvm install ${NODE_VERSION}
RUN . "$NVM_DIR/nvm.sh" && nvm use v${NODE_VERSION}
RUN . "$NVM_DIR/nvm.sh" && nvm alias default v${NODE_VERSION}
ENV PATH="/root/.nvm/versions/node/v${NODE_VERSION}/bin/:${PATH}"
# RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" && \
#     unzip -q awscliv2.zip && \ 
#     sudo ./aws/install

WORKDIR /app
COPY package*.json ./
COPY packages/agent-core/package*.json ./packages/agent-core/
COPY packages/worker/package*.json ./packages/worker/
RUN npm ci
COPY ./ ./
RUN cd packages/agent-core && npm run build
# RUN cd packages/worker && npm run bundle

WORKDIR /app/packages/worker
EXPOSE 8080
CMD ["npx", "tsx", "src/agent-core.ts"]
