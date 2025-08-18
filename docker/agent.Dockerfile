FROM public.ecr.aws/ubuntu/ubuntu:noble

RUN apt-get update && apt-get install -y
RUN apt-get install -y curl wget

RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash
ENV NODE_VERSION=22.18.0
ENV NVM_DIR=/root/.nvm
RUN . "$NVM_DIR/nvm.sh" && nvm install ${NODE_VERSION} && nvm use v${NODE_VERSION} && nvm alias default v${NODE_VERSION}
ENV PATH="/root/.local/bin/:/root/.nvm/versions/node/v${NODE_VERSION}/bin/:${PATH}"

# install python
RUN apt-get update && \
  apt-get install -y python3-pip unzip && \
  ln -s -f /usr/bin/pip3 /usr/bin/pip && \
  ln -s -f /usr/bin/python3 /usr/bin/python

# install uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh

# install aws cli
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip" && \
  unzip awscliv2.zip && rm -f awscliv2.zip && \
  ./aws/install

  # Install GitHub CLI https://github.com/cli/cli/blob/trunk/docs/install_linux.md
RUN (type -p wget >/dev/null || (apt update && apt-get install wget -y)) && \
  mkdir -p -m 755 /etc/apt/keyrings && \
  out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg && \
  cat $out | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null && \
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
  apt-get update && \
  apt-get install gh -y

# install gh-token
RUN git config --global user.name "remote-swe-app[bot]" && \
  git config --global user.email "123456+remote-swe-app[bot]@users.noreply.github.com"
RUN curl -L "https://github.com/Link-/gh-token/releases/download/v2.0.5/linux-arm64" -o gh-token && \
  chmod +x gh-token && \
  mv gh-token /usr/bin

WORKDIR /app
COPY package*.json ./
COPY packages/agent-core/package*.json ./packages/agent-core/
COPY packages/worker/package*.json ./packages/worker/
RUN npm ci
COPY ./ ./
RUN cd packages/agent-core && npm run build

WORKDIR /app/packages/worker
EXPOSE 8080
CMD ["./run.sh"]
