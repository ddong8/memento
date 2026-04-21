FROM python:3.12-slim

WORKDIR /app

# Install CPU-only PyTorch (smaller than CUDA version)
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

# Install sentence-transformers
RUN pip install --no-cache-dir sentence-transformers

# Copy embedding server
COPY embedding_server.py .

# Pre-download BGE-M3 model into image
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('BAAI/bge-m3')"

EXPOSE 8002

CMD ["python", "embedding_server.py", "--port", "8002"]
