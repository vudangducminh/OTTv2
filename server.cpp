/*
 * server.cpp
 * Bai tap: Tinh tong N so - Server (co bat tay, da luong)
 *
 * Giao thuc (xem protocol.docx):
 *   1. Client -> Server : HELLO
 *   2. Server -> Client : WELCOME
 *   3. Client -> Server : REQUEST <N>
 *   4. Server -> Client : DATA <so1> <so2> ... <soN>   (server tu sinh N so ngau nhien)
 *   5. Client -> Server : SUM <tong_client>            (client tu tinh tong N so vua nhan)
 *   6. Server -> Client : OK                            (neu tong_client dung)
 *                          hoac SAI <tong_dung>          (neu tong_client sai)
 *   7. Client -> Server : BYE
 *   8. Server -> Client : CLOSE
 *
 * Moi client duoc phuc vu boi mot thread rieng, nen server co the
 * xu ly nhieu client cung luc.
 *
 * Bien dich:
 *   g++ server.cpp -o server -pthread
 * Chay:
 *   ./server
 */

#include <iostream>
#include <sstream>
#include <string>
#include <vector>
#include <cstring>
#include <random>
#include <thread>
#include <mutex>
#include <system_error>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#define PORT 8080
#define MIN_N 1
#define MAX_N 1000
#define RAND_MIN_VAL 1
#define RAND_MAX_VAL 100

// Khoa dung chung cho std::cout, tranh cac dong log cua nhieu thread bi tron lan
static std::mutex logMutex;

static void logMsg(const std::string &clientId, const std::string &msg) {
    std::lock_guard<std::mutex> lock(logMutex);
    std::cout << "[" << clientId << "] " << msg << std::endl;
}

// Sinh so ngau nhien trong [RAND_MIN_VAL, RAND_MAX_VAL].
// Moi thread co bo sinh rieng (thread_local) nen khong can khoa.
static int randomNumber() {
    thread_local std::mt19937 gen(std::random_device{}());
    std::uniform_int_distribution<int> dist(RAND_MIN_VAL, RAND_MAX_VAL);
    return dist(gen);
}

// Doc mot dong (ket thuc boi '\n') tu socket, tra ve chuoi khong bao gom '\n'
static std::string recvLine(int sockFd) {
    std::string line;
    char c;
    while (true) {
        ssize_t n = recv(sockFd, &c, 1, 0);
        if (n <= 0) break;      // client dong ket noi hoac loi
        if (c == '\n') break;
        line += c;
    }
    return line;
}

static void sendLine(int sockFd, const std::string &msg) {
    std::string out = msg + "\n";
    // MSG_NOSIGNAL: neu client da ngat ket noi thi send() tra ve loi
    // thay vi gui SIGPIPE lam chet ca server (va moi client khac).
    send(sockFd, out.c_str(), out.size(), MSG_NOSIGNAL);
}

// Xu ly toan bo phien lam viec voi 1 client
static void handleClient(int clientFd, const std::string &clientId) {
    // ----- Buoc 1-2: Bat tay (handshake) -----
    std::string hello = recvLine(clientFd);
    logMsg(clientId, "Nhan: " + hello);

    if (hello != "HELLO") {
        sendLine(clientFd, "LOI Yeu_cau_bat_tay_HELLO_truoc");
        return;
    }
    sendLine(clientFd, "WELCOME");
    logMsg(clientId, "Bat tay thanh cong.");

    // ----- Buoc 3: Nhan yeu cau REQUEST <N> -----
    std::string request = recvLine(clientFd);
    logMsg(clientId, "Nhan: " + request);

    std::istringstream iss(request);
    std::string command;
    iss >> command;

    if (command != "REQUEST") {
        sendLine(clientFd, "LOI Sai_lenh_yeu_cau_REQUEST");
        return;
    }

    int n;
    if (!(iss >> n) || n < MIN_N || n > MAX_N) {
        sendLine(clientFd, "LOI So_luong_N_khong_hop_le");
        return;
    }

    // ----- Buoc 4: Sinh N so ngau nhien, gui cho client -----
    std::vector<int> numbers(n);
    long long realSum = 0;
    std::ostringstream dataMsg;
    dataMsg << "DATA";
    for (int i = 0; i < n; i++) {
        numbers[i] = randomNumber();
        realSum += numbers[i];
        dataMsg << " " << numbers[i];
    }
    sendLine(clientFd, dataMsg.str());
    logMsg(clientId, "Da gui " + std::to_string(n) + " so, tong that = " + std::to_string(realSum));

    // ----- Buoc 5: Nhan tong do client tu tinh -----
    std::string sumMsg = recvLine(clientFd);
    logMsg(clientId, "Nhan: " + sumMsg);

    std::istringstream iss2(sumMsg);
    std::string sumCmd;
    long long clientSum;
    iss2 >> sumCmd;

    if (sumCmd != "SUM" || !(iss2 >> clientSum)) {
        sendLine(clientFd, "LOI Sai_dinh_dang_ban_tin_SUM");
        return;
    }

    // ----- Buoc 6: So sanh va bao ket qua -----
    if (clientSum == realSum) {
        sendLine(clientFd, "OK");
        logMsg(clientId, "Dung. Tong = " + std::to_string(realSum));
    } else {
        sendLine(clientFd, "SAI " + std::to_string(realSum));
        logMsg(clientId, "Sai. Client gui " + std::to_string(clientSum) +
                         ", tong dung la " + std::to_string(realSum));
    }

    // ----- Buoc 7-8: Ket thuc phien -----
    std::string bye = recvLine(clientFd);
    logMsg(clientId, "Nhan: " + bye);
    if (bye == "BYE") {
        sendLine(clientFd, "CLOSE");
    }
}

int main() {
    int listenFd = socket(AF_INET, SOCK_STREAM, 0);
    if (listenFd == -1) {
        perror("socket");
        return 1;
    }

    int opt = 1;
    setsockopt(listenFd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(PORT);

    if (bind(listenFd, (struct sockaddr *)&addr, sizeof(addr)) == -1) {
        perror("bind");
        return 1;
    }

    if (listen(listenFd, 10) == -1) {
        perror("listen");
        return 1;
    }

    std::cout << "Server dang lang nghe tren port " << PORT << " ..." << std::endl;

    while (true) {
        struct sockaddr_in clientAddr;
        socklen_t clientLen = sizeof(clientAddr);
        int clientFd = accept(listenFd, (struct sockaddr *)&clientAddr, &clientLen);
        if (clientFd == -1) {
            perror("accept");
            continue;
        }

        // Dinh danh client bang IP:port de phan biet nhieu client cung 1 may
        char ipStr[INET_ADDRSTRLEN];
        inet_ntop(AF_INET, &clientAddr.sin_addr, ipStr, sizeof(ipStr));
        std::string clientId = std::string(ipStr) + ":" + std::to_string(ntohs(clientAddr.sin_port));

        logMsg(clientId, "Ket noi moi.");

        // Tao thread rieng cho client nay, main quay lai accept() ngay
        try {
            std::thread([clientFd, clientId]() {
                handleClient(clientFd, clientId);
                close(clientFd);
                logMsg(clientId, "Da dong ket noi.");
            }).detach();
        } catch (const std::system_error &e) {
            std::cerr << "Khong tao duoc thread: " << e.what() << std::endl;
            close(clientFd);
        }
    }

    close(listenFd);
    return 0;
}
