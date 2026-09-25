# One image, three modes (ADR 7): sync | rest | auth. linux/arm64 like the rest of the stack.
# No runtime dependencies: Node 22 runs the TypeScript sources directly and has SQLite built in.
FROM node:22.22-alpine
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production \
    PLAUD_STATE_DIR=/state \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
RUN mkdir -p /state && chown node:node /state
USER node
VOLUME ["/state"]
ENTRYPOINT ["node", "src/cli.ts"]
CMD ["status"]
