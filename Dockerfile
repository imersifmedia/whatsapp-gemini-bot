# Menggunakan Node.js versi 18 sebagai base image
FROM node:18

# Mengatur direktori kerja di dalam container
WORKDIR /app

# Menyalin package.json dan package-lock.json secara eksplisit
# Perintah ini lebih spesifik untuk mencegah kesalahan
COPY package.json package-lock.json ./

# Menjalankan instalasi Node.js dependencies
RUN npm install

# Menyalin semua file proyek ke dalam container
COPY . .

# Menentukan perintah untuk menjalankan bot saat container dimulai
CMD ["node", "index.js"]