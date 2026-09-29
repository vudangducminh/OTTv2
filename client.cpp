/*
 * client.cpp
 * Bai tap: Tinh tong N so - Client (co bat tay)
 *
 * Giao thuc (xem protocol.docx):
 *   1. Client -> Server : HELLO
 *   2. Server -> Client : WELCOME
 *   3. Client -> Server : REQUEST <N>
 *   4. Server -> Client : DATA <so1> <so2> ... <soN>
 *   5. Client -> Server : SUM <tong_client>
 *   6. Server -> Client : OK / SAI <tong_dung>
 *   7. Client -> Server : BYE
 *   8. Server -> Client : CLOSE
 *
 * LUU Y: chuong trinh KHONG tu dong cong ho. Sau khi nhan N so tu server,
 * NGUOI DUNG phai tu tinh tong (bang tay/nham) va nhap ket qua vao,
 * chuong trinh chi gui dung gia tri nguoi dung nhap len server.
 *
 * Bien dich:
 *   g++ client.cpp -o client
 * Chay (mac dinh ket noi 127.0.0.1:8080):
 *   ./client
 *   ./client <server_ip> <port>
 */

#include <iostream>
#include <sstream>
#include <string>
#include <vector>
#include <cstring>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#define DEFAULT_PORT 8080

static std::string recvLine(int sockFd) {
    std::string line;
    char c;
    while (true) {
        ssize_t n = recv(sockFd, &c, 1, 0);
        if (n <= 0) break;
        if (c == '\n') break;
        line += c;
    }
    return line;
}

static void sendLine(int sockFd, const std::string &msg) {
    std::string out = msg + "\n";
    send(sockFd, out.c_str(), out.size(), 0);
}

int main(int argc, char *argv[]) {
    std::string serverIp = (argc > 1) ? argv[1] : "127.0.0.1";
    int port = (argc > 2) ? std::stoi(argv[2]) : DEFAULT_PORT;

    // ----- Tao ket noi TCP toi server -----
    int sockFd = socket(AF_INET, SOCK_STREAM, 0);
    if (sockFd == -1) {
        perror("socket");
        return 1;
    }

    struct sockaddr_in serverAddr;
    memset(&serverAddr, 0, sizeof(serverAddr));
    serverAddr.sin_family = AF_INET;
    serverAddr.sin_port = htons(port);

    if (inet_pton(AF_INET, serverIp.c_str(), &serverAddr.sin_addr) != 1) {
        std::cerr << "Dia chi IP khong hop le: " << serverIp << std::endl;
        return 1;
    }

    if (connect(sockFd, (struct sockaddr *)&serverAddr, sizeof(serverAddr)) == -1) {
        perror("connect");
        return 1;
    }

    // ----- Buoc 1-2: Bat tay -----
    sendLine(sockFd, "HELLO");
    std::string welcome = recvLine(sockFd);
    std::cout << "Server: " << welcome << std::endl;

    if (welcome != "WELCOME") {
        std::cerr << "Bat tay that bai, ket thuc." << std::endl;
        close(sockFd);
        return 1;
    }

    // ----- Buoc 3: Gui yeu cau REQUEST <N> -----
    int n;
    std::cout << "Nhap so luong so muon xin tu server (N): ";
    std::cin >> n;

    sendLine(sockFd, "REQUEST " + std::to_string(n));

    // ----- Buoc 4: Nhan N so tu server -----
    std::string dataMsg = recvLine(sockFd);

    std::istringstream iss(dataMsg);
    std::string command;
    iss >> command;

    if (command == "LOI") {
        std::string reason;
        iss >> reason;
        std::cout << "==> Server bao loi: " << reason << std::endl;
        close(sockFd);
        return 1;
    }

    if (command != "DATA") {
        std::cout << "==> Phan hoi khong hop le tu server: " << dataMsg << std::endl;
        close(sockFd);
        return 1;
    }

    std::vector<long long> numbers;
    long long value;
    while (iss >> value) {
        numbers.push_back(value);
    }

    std::cout << "Server gui ve " << numbers.size() << " so: ";
    for (size_t i = 0; i < numbers.size(); i++) {
        std::cout << numbers[i] << (i + 1 < numbers.size() ? " " : "\n");
    }

    // Nguoi dung tu cong cac so tren bang tay/nham tinh, roi nhap ket qua vao.
    // Chuong trinh KHONG tu dong tinh tong ho.
    long long clientSum;
    std::cout << "Hay tu tinh tong cua " << numbers.size()
              << " so tren va nhap ket qua: ";
    std::cin >> clientSum;

    // ----- Buoc 5: Gui tong len server -----
    sendLine(sockFd, "SUM " + std::to_string(clientSum));

    // ----- Buoc 6: Nhan ket qua xac nhan -----
    std::string result = recvLine(sockFd);
    std::istringstream iss2(result);
    std::string status;
    iss2 >> status;

    if (status == "OK") {
        std::cout << "==> Server xac nhan: DUNG." << std::endl;
    } else if (status == "SAI") {
        long long correctSum;
        iss2 >> correctSum;
        std::cout << "==> Server xac nhan: SAI. Tong dung phai la " << correctSum << std::endl;
    } else if (status == "LOI") {
        std::string reason;
        iss2 >> reason;
        std::cout << "==> Loi tu server: " << reason << std::endl;
    } else {
        std::cout << "==> Phan hoi khong xac dinh: " << result << std::endl;
    }

    // ----- Buoc 7-8: Ket thuc phien -----
    sendLine(sockFd, "BYE");
    std::string closeMsg = recvLine(sockFd);
    std::cout << "Server: " << closeMsg << std::endl;

    close(sockFd);
    return 0;
}
