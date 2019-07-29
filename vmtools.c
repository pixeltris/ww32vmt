// merge winapi-full-for-X.X.XX.zip "include" folder into the tcc "include" folder
// tcc -impdef ws2_32.dll -o lib/ws2_32.def
// compile without console: tcc vmtools.c lib/user32.def lib/gdi32.def lib/ws2_32.def -Wl,-subsystem=windows -DUSE_CONSOLE=0
// compile with console: tcc vmtools.c lib/user32.def lib/gdi32.def lib/ws2_32.def -DUSE_CONSOLE=1
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <windows.h>
#include <winsock.h>
#include <assert.h>

#if USE_CONSOLE
#define vmprintf(str, ...) printf(str, ##__VA_ARGS__)
#else
#define vmprintf(str, ...)// { char vmprintfStr[1024]; sprintf(vmprintfStr, str, ##__VA_ARGS__); MessageBox(NULL, vmprintfStr, "", 0); }
#endif

const uint32_t hostMagicComm = 0xE2B13904;// States the host is ready for communication
const uint32_t hostMagicXfer = 0x8D93F023;// States the host has transferred the main exe into the buffer
const uint32_t hostMagicDead = 0x152339D9;// States the host no longer exists
const uint32_t guestMagicComm = 0x3904FEBB;// States the guest sees the host, and it can be used for communication
const uint32_t guestMagicXfer = 0x16222FED;// States the guest sees the host, and it wants to the host to transfer the main exe
const uint32_t guestMagicDead = 0x1B880C2C;// States the guest no longer exists

const int32_t g_blockSize = 4096;
const int32_t g_numBlocks = 256;
const int32_t g_blockHeaderFooterLen = 20;
const int32_t g_blockHeaderFooterLenTotal = 40;//g_blockHeaderFooterLen * 2;

uint8_t* g_sharedMemory = NULL;
uint8_t* g_sharedData = NULL;
const int32_t g_sharedDataOffset = 8;// Shared data comes after the host/guest magic

uint64_t g_totalBytesVmToHost = 0;
uint64_t g_totalBytesHostToVm = 0;
uint64_t g_totalPacketsVmToHost = 0;
uint64_t g_totalPacketsHostToVm = 0;
int32_t g_lastRefreshUI = 0;
#define REFRESH_UI_DELAY 3000

// This doesn't really work when the this isn't the focused browser tab?
int32_t g_lastKeepAlive = 0;
int32_t g_lastSendKeepAlive = 0;
#define USE_KEEP_ALIVE 0
#define KEEP_ALIVE_DELAY 5000
#define KEEP_ALIVE_TIMEOUT 30000

int32_t g_isWindowsPlatformNT;

CRITICAL_SECTION packetCriticalSection = { 0 };

typedef enum
{
	PT_MiscData,
	PT_FileData,
	PT_NetworkData,
	PT_MAX
} PacketType;

typedef enum
{
	MP_Clipboard,
	MP_KeepAlive
} MiscPacketType;

typedef enum
{
	NT_HttpProxy,
	NT_HttpsProxy,
	NT_DnsProxy,
	NT_SocksProxy,
	NT_HttpProxyEmulated,// Server emulated in JS
	NT_HttpsProxyEmulated,// Server emulated in JS
	NT_MAX
} NetworkType;

#define PROXY_CONNECT 0
#define PROXY_DISCONNECT 1
#define PROXY_RECV 2
#define PROXY_SEND 3
#define PROXY_RECV_UDP 4
#define PROXY_SEND_UDP 5
#define MAX_PROXY_CONNECTIONS 512
#define PROXY_HTTP_PORT 80
#define PROXY_HTTPS_PORT 443
#define PROXY_HTTP_EMULATED_PORT 980
#define PROXY_HTTPS_EMULATED_PORT 9443
#define PROXY_SOCKS_PORT 1080
#define PROXY_DNS_PORT 53
typedef struct ProxyConnection
{
	SOCKET Socket;
	uint16_t Index;
	uint8_t IsConnected;
	uint8_t NetworkType;
} ProxyConnection;
ProxyConnection proxyConnections[MAX_PROXY_CONNECTIONS] = { 0 };
uint16_t nextProxyConnectionIndex = 0;
SOCKET serverSockets[NT_MAX] = { INVALID_SOCKET };
uint16_t serverSocketsPorts[NT_MAX] = { 0 };

#define FT_HOST_TO_VM 0
#define FT_VM_TO_HOST 1
#define FT_DATA 2
#define FT_END 3

#define SHARED_FOLDER_NAME L"Shared"

typedef struct FileTransferItem
{
	wchar_t Path[MAX_PATH];// Maybe malloc a wchar_t* rather than requiring this large buffer?
	FILE* FileHandle;
	int32_t IsDirectory;
	uint32_t Offset;
	uint32_t Length;
	struct FileTransferItem* Next;
} FileTransferItem;

FileTransferItem* fileTransferFiles;// Linked list of files
int32_t fileTransferDirection = -1;
wchar_t fileTransferBaseDirectory[MAX_PATH] = { 0 };

typedef struct PacketData
{
	struct PacketData* Next;
	uint8_t* Buffer;
	uint32_t Offset;
	uint32_t Length;
	uint8_t RequiresFree;
	uint8_t Cancel;
} PacketData;

#define TOTAL_PACKET_BLOCKS (PT_MAX * 2)
#define PACKET_BLOCK_SIZE (((g_blockSize * g_numBlocks) - g_sharedDataOffset) / TOTAL_PACKET_BLOCKS)
#define PACKET_BLOCK_HEADER_SIZE 17
#define PACKET_BLOCK_DATA_SIZE (PACKET_BLOCK_SIZE - PACKET_BLOCK_HEADER_SIZE)
#define MAX_QUEUED_PACKETS 0xFFFF
int32_t packetOffsets[TOTAL_PACKET_BLOCKS] = { 0 };
PacketData* packetWriters[PT_MAX] = { 0 };
PacketData* packetReaders[PT_MAX] = { 0 };
int32_t validateProxyConnection(ProxyConnection* connection, SOCKET socket);
void freeProxyConnection(ProxyConnection* connection);

#define CODE_PAGE_STR_SIZE 20
uint32_t getLocaleCodePage(LCID locale, LCTYPE localeType)
{
	char codePageStr[CODE_PAGE_STR_SIZE];
	uint32_t codePage;
	if (GetLocaleInfo(locale, localeType, codePageStr, CODE_PAGE_STR_SIZE))
	{
		codePage = strtol(codePageStr, NULL, 10);
	}
	else
	{
		switch (localeType)
		{
			case LOCALE_IDEFAULTCODEPAGE:
				codePage = CP_OEMCP;
				break;
			case LOCALE_IDEFAULTANSICODEPAGE:
				codePage = CP_ACP;
				break;
			default:
				codePage = CP_MACCP;
				break;
		}
	}
	return codePage;
}

// The following two functions don't support CP_UTF7/CP_UTF8 on Windows 95 (unicows.dll export the
// functions with CP_UTF7/CP_UTF8 implementations, so that can be used if unicode conversion is required.
// unicows.dll isn't installed by default so that would need to be transferred to the VM manually)
char* utf16ToCodePage(int32_t codePage, const wchar_t* str, int32_t strLen, uint32_t* outStrLen)
{
	int size = WideCharToMultiByte(codePage, 0, str, strLen, NULL, 0, NULL, NULL);
	if (size > 0)
	{
		char* result = malloc(size + 1);
		if (result)
		{
			WideCharToMultiByte(codePage, 0, str, strLen, result, size, NULL, NULL);
			if (outStrLen != NULL)
			{
				*outStrLen = size;
			}
			result[size] = 0;
			return result;
		}
	}
	return NULL;
}

wchar_t* codePageToUtf16(int32_t codePage, const char* str, int32_t strLen, uint32_t* outStrLen)
{
	int utf16Len = MultiByteToWideChar(codePage, 0, str, strLen, NULL, 0);
	if (utf16Len > 0)
	{
		int utf16ByteLen = (utf16Len + 1) * sizeof(wchar_t);
		wchar_t* utf16Str = (wchar_t*)malloc(utf16ByteLen);
		if (utf16Str != NULL)
		{
			MultiByteToWideChar(codePage, 0, str, strLen, utf16Str, utf16Len);
			if (outStrLen != NULL)
			{
				*outStrLen = utf16Len;
			}
			utf16Str[utf16Len] = 0;
			return utf16Str;
		}
	}
	return NULL;
}

int32_t isWindowsPlatformNT()
{
	OSVERSIONINFO vi = { 0 };
	vi.dwOSVersionInfoSize = sizeof(vi);
	GetVersionEx(&vi);
	return vi.dwPlatformId == VER_PLATFORM_WIN32_NT;
}

void DrawString(HDC hdc, const char* str)
{
	SetTextColor(hdc, RGB(0, 0, 0));
	RECT rect = { 0, 0, 250, 200 };
	DrawText(hdc, str, strlen(str), &rect, DT_TOP|DT_LEFT);
}

void forceDisconnect()
{
	if (g_sharedMemory == NULL)
	{
		return;
	}
	vmprintf("Force disconnect (an allocation failed, or buffers filled up)\n");
	((uint32_t*)g_sharedMemory)[1] = guestMagicDead;
	PostQuitMessage(0);
}

int32_t isDisconnected()
{
	EnterCriticalSection(&packetCriticalSection);
	int32_t result = g_sharedMemory == NULL || ((uint32_t*)g_sharedMemory)[1] == guestMagicDead || ((uint32_t*)g_sharedMemory)[0] == hostMagicDead;
	LeaveCriticalSection(&packetCriticalSection);
	return result;
}

int32_t ensureConnected()
{
	if (isDisconnected())
	{
		vmprintf("[WARNING] Attempted to access shared memory after disconnected / memory freed\n");
		return 0;
	}
	return 1;
}

void queuePacketImpl(PacketType packetType, uint8_t* buffer, uint32_t bufferLen, uint8_t requiresFree)
{
	if (!ensureConnected() || buffer == NULL || bufferLen == 0 || packetType < 0 || packetType >= PT_MAX)
	{
		return;
	}
	PacketData* packetData = (PacketData*)calloc(1, sizeof(PacketData));
	if (!packetData)
	{
		forceDisconnect();
		return;
	}
	packetData->Buffer = buffer;
	packetData->Offset = 0;
	packetData->Length = bufferLen;
	packetData->RequiresFree = requiresFree;
	packetData->Cancel = 0;
	packetData->Next = NULL;
	
	PacketData* item = packetWriters[packetType];
	if (item != NULL)
	{
		int32_t count = 0;
		while (item->Next != NULL)
		{
			item = item->Next;
			count++;
			if (count > MAX_QUEUED_PACKETS)
			{
				forceDisconnect();
				return;
			}
		}
		item->Next = packetData;
	}
	else
	{
		packetWriters[packetType] = packetData;
	}
}

void queuePacket(PacketType packetType, uint8_t* buffer, uint32_t bufferLen, uint8_t requiresFree)
{
	EnterCriticalSection(&packetCriticalSection);
	queuePacketImpl(packetType, buffer, bufferLen, requiresFree);
	LeaveCriticalSection(&packetCriticalSection);
}

void queuePacket_KeepAlive()
{
	uint32_t totalBufferLen = 1;
	uint8_t* ptr = (uint8_t*)malloc(totalBufferLen);
	ptr[0] = MP_KeepAlive;
	queuePacket(PT_MiscData, ptr, totalBufferLen, 1);
}

void queuePacket_GetClipboardDataResponse(uint8_t clipboardDataType, uint8_t* buffer, uint32_t bufferLen)
{
	uint32_t totalBufferLen = bufferLen + 3;
	uint8_t* ptr = (uint8_t*)malloc(totalBufferLen);
	ptr[0] = MP_Clipboard;
	ptr[1] = 1;// Get clipboard data (response)
	ptr[2] = clipboardDataType;// Text / image
	memcpy(ptr + 3, buffer, bufferLen);
	queuePacket(PT_MiscData, ptr, totalBufferLen, 1);
}

void queuePacket_GetClipboardDataResponseUTF16(wchar_t* str, int32_t strLen)
{
	queuePacket_GetClipboardDataResponse(0, (uint8_t*)str, strLen * sizeof(wchar_t));
}

void queuePacket_GetFilesFromVMResponse()
{
	int32_t bufferLen = 2;
	uint8_t* ptr = (uint8_t*)malloc(bufferLen);
	ptr[0] = FT_VM_TO_HOST;
	ptr[1] = fileTransferDirection >= 0;// Confirm that a file transfer should occur
	queuePacket(PT_FileData, ptr, bufferLen, 1);
}

void queuePacket_GetFilesFromVMEnd(int8_t isCancel)
{
	int32_t bufferLen = 2;
	uint8_t* ptr = (uint8_t*)malloc(bufferLen);
	ptr[0] = FT_END;
	ptr[1] = isCancel;
	queuePacket(PT_FileData, ptr, bufferLen, 1);
}

void queuePacket_GetFilesFromVMData(FileTransferItem* item)
{
	// We want the file transfer block size to be as big as possible (up to the regular packet block size).
	// If the total size is >= the regular block size then multiple requests will be sent per file block.
	int32_t headerLen = 0;
	int32_t pathLen = 0;
	if (item->Offset == 0)
	{
		pathLen = wcslen(item->Path);
		headerLen = (1+4+4+1+4+(pathLen*sizeof(wchar_t))+4);
	}
	else
	{
		headerLen = (1+4+4+4);
	}
	int32_t dataSize = min(item->Length - item->Offset, PACKET_BLOCK_DATA_SIZE - headerLen);
	
	int32_t bufferLen = dataSize + headerLen;
	int32_t pOffset = 0;
	
	uint8_t* ptr = malloc(bufferLen);
	if (ptr == NULL)
	{
		// TODO: Logging
		return;
	}
	
	*(uint8_t*)(ptr + pOffset) = FT_DATA;
	pOffset += 1;
	*(uint32_t*)(ptr + pOffset) = item->Offset;
	pOffset += 4;
	*(uint32_t*)(ptr + pOffset) = item->Length;
	pOffset += 4;
	
	if (item->Offset == 0)
	{
		*(uint8_t*)(ptr + pOffset) = item->IsDirectory;
		pOffset += 1;
		*(int32_t*)(ptr + pOffset) = pathLen;
		pOffset += 4;
		memcpy(ptr + pOffset, item->Path, pathLen * sizeof(wchar_t));
		pOffset += (pathLen * sizeof(wchar_t));
	}
	
	*(int32_t*)(ptr + pOffset) = dataSize;
	pOffset += 4;
	
	int32_t isComplete = 0;
	if (dataSize == 0 || item->FileHandle == NULL)
	{
		isComplete = 1;
	}
	else if (fseek(item->FileHandle, item->Offset, SEEK_SET) != 0)
	{
		isComplete = 1;
	}
	else
	{
		item->Offset += dataSize;
		if (fread(ptr + pOffset, 1, dataSize, item->FileHandle) != dataSize || item->Offset >= item->Length)
		{
			isComplete = 1;
		}
	}
	if (isComplete)
	{
		item->Offset = item->Length;
	}
	queuePacket(PT_FileData, ptr, bufferLen, 1);
}

void queuePacket_GetFilesFromVMDataNext()
{
	if (fileTransferDirection != FT_VM_TO_HOST)
	{
		return;
	}
	FileTransferItem* item = fileTransferFiles;
	while (item != NULL)
	{
		if (item->FileHandle == NULL)
		{
			if (!item->IsDirectory)
			{
				if (g_isWindowsPlatformNT)
				{
					item->FileHandle = _wfopen(item->Path, L"rb");
				}
				else
				{
					char tempStr[MAX_PATH];
					wcstombs(tempStr, item->Path, MAX_PATH);
					item->FileHandle = fopen(tempStr, "rb");
				}
				if (item->FileHandle == NULL)
				{
					fileTransferFiles = item->Next;
					free(item);
					item = fileTransferFiles;
					continue;
				}
			}
			queuePacket_GetFilesFromVMData(item);
			if (item->Offset >= item->Length)
			{
				fileTransferFiles = item->Next;
				if (item->FileHandle != NULL)
				{
					fclose(item->FileHandle);
				}
				free(item);
			}
			return;
		}
		else
		{
			queuePacket_GetFilesFromVMData(item);
			if (item->Offset >= item->Length)
			{
				fileTransferFiles = item->Next;
				if (item->FileHandle != NULL)
				{
					fclose(item->FileHandle);
				}
				free(item);
			}
			return;
		}
	}
	if (item == NULL)
	{
		queuePacket_GetFilesFromVMEnd(0);
		fileTransferFiles = NULL;
		fileTransferDirection = -1;
	}
}

void queuePacket_NetworkPacket(ProxyConnection* connection, uint8_t networkType, uint8_t networkPacketType, uint8_t* buffer, uint32_t bufferLen)
{
	uint32_t totalBufferLen = (buffer == NULL ? 0 : bufferLen) + 2;
	if (connection != NULL)
	{
		totalBufferLen += 4 + 4;
	}
	uint8_t* ptr = (uint8_t*)malloc(totalBufferLen);
	int32_t offset = 0;
	ptr[offset] = networkType;
	offset += 1;
	ptr[offset] = networkPacketType;
	offset += 1;
	if (connection != NULL)
	{
		*(uint32_t*)(ptr+offset) = connection->Index;
		offset += 4;
		*(uint32_t*)(ptr+offset) = (uint32_t)connection->Socket;
		offset += 4;
	}
	if (buffer != NULL)
	{
		memcpy(ptr + offset, buffer, bufferLen);
	}
	queuePacket(PT_NetworkData, ptr, totalBufferLen, 1);
}

void queuePacket_ProxyConnectionConnect(ProxyConnection* connection)
{
	queuePacket_NetworkPacket(connection, connection->NetworkType, PROXY_CONNECT, NULL, 0);
}

void queuePacket_ProxyConnectionDisconnected(ProxyConnection* connection)
{
	queuePacket_NetworkPacket(connection, connection->NetworkType, PROXY_DISCONNECT, NULL, 0);
}

void queuePacket_ProxyConnectionRecv(ProxyConnection* connection, uint8_t* buffer, uint32_t bufferLen)
{
	queuePacket_NetworkPacket(connection, connection->NetworkType, PROXY_RECV, buffer, bufferLen);
}

void queuePacket_ProxyConnectionRecvUdp(NetworkType networkType, uint8_t* buffer, uint32_t bufferLen)
{
	queuePacket_NetworkPacket(NULL, networkType, PROXY_RECV_UDP, buffer, bufferLen);
}

void initPacketOffsets()
{
	int32_t offset = g_sharedDataOffset;
	int32_t size = PACKET_BLOCK_SIZE;
	for (int32_t i = 0; i < TOTAL_PACKET_BLOCKS; i++)
	{
		packetOffsets[i] = offset;
		offset += size;
	}
}

void processNetworkPacket(PacketData* packetData)
{
	uint8_t* buffer = packetData->Buffer;
	switch (buffer[0])
	{
		case NT_HttpProxyEmulated:
		case NT_HttpsProxyEmulated:
		case NT_HttpProxy:
		case NT_HttpsProxy:
		case NT_SocksProxy:
			{
				uint8_t* buffer = packetData->Buffer;
				int32_t connectionIndex = *(int32_t*)(buffer + 2);
				SOCKET connectionSocket = (SOCKET)*(uint32_t*)(buffer + 6);
				//vmprintf("Proxy(%d) %d %d\n", (int32_t)packetType, connectionIndex, connectionSocket);
				if (connectionIndex >= 0 && connectionIndex < MAX_PROXY_CONNECTIONS)
				{
					ProxyConnection* connection = &proxyConnections[connectionIndex];
					if (validateProxyConnection(connection, connectionSocket))
					{
						switch (buffer[1])
						{
							case PROXY_DISCONNECT:
								{
									freeProxyConnection(connection);
									shutdown(connectionSocket, SD_BOTH);
									closesocket(connectionSocket);
								}
								break;
							case PROXY_SEND:
								{
									uint8_t* data = buffer + 10;
									int32_t dataLen = packetData->Length - 10;
									vmprintf("Socket send: %d\n", dataLen);
									// This is blocking but this doesn't intract with any real networks
									// so this should be fast enough to avoid dispatching to another thread
									int32_t sentBytes = 0;
									if ((sentBytes = send(connectionSocket, data, dataLen, 0)) != dataLen)
									{
										vmprintf("Failed to send all data. Sent %d / %d\n", sentBytes, dataLen);
										if (validateProxyConnection(connection, connectionSocket))
										{
											freeProxyConnection(connection);
											shutdown(connectionSocket, SD_BOTH);
											closesocket(connectionSocket);
										}
									}
								}
								break;
							default:
								{
									vmprintf("Unhandled proxy packet type %d\n", (int32_t)buffer[0]);
								}
								break;
						}
					}
				}
			}
			break;
		case NT_DnsProxy:
			{
				SOCKET dnsServerSocket = serverSockets[NT_DnsProxy];
				//vmprintf("UDP %p %d %d\n", dnsServerSocket, (int32_t)packetData->Buffer[0], packetType);
				if (dnsServerSocket != INVALID_SOCKET)
				{
					uint8_t* buffer = packetData->Buffer;
					switch (buffer[1])
					{
						case PROXY_SEND_UDP:
							{
								uint8_t* buffer = packetData->Buffer;
								uint32_t addrSize = *(uint32_t*)(buffer + 2);
								struct sockaddr_in addr = { 0 };
								memcpy(&addr, buffer + 6, min(addrSize, sizeof(addr)));
							
								uint8_t* data = buffer + 6 + addrSize;
								uint32_t dataLen = packetData->Length - (6 + addrSize);
								sendto(dnsServerSocket, data, dataLen, 0, &addr, sizeof(addr));
								//vmprintf("PROXY_SEND_UDP %d %d %s %d\n", addrSize, dataLen, inet_ntoa(addr.sin_addr), addr.sin_addr);
							}
							break;
						default:
							{
								vmprintf("Unhandled UDP proxy packet type %d\n", (int32_t)buffer[0]);
							}
							break;
					}
				}
			}
			break;
	}
}

void processClipboardPacket(PacketData* packetData)
{
	uint8_t* buffer = packetData->Buffer;
	if (buffer[0] == 0)
	{
		// Set clipboard data
		switch (buffer[1])
		{
			case 0:// Text
				{
					if (OpenClipboard(NULL))
					{
						if (EmptyClipboard())
						{
							wchar_t* utf16Str = (wchar_t*)(buffer + 2);
							int32_t utf16ByteLen = (packetData->Length - 2);
							int32_t utf16StrLen = utf16ByteLen / sizeof(wchar_t);
							
							// Windows 2000+ has full support for CF_UNICODETEXT.
							// Windows 98 IE supports CF_UNICODETEXT. Notepad and other programs don't.
							// Windows 95?
							
							// CF_UNICODETEXT
							//if (g_isWindowsPlatformNT)
							{
								HGLOBAL hdata = GlobalAlloc(GMEM_MOVEABLE, utf16ByteLen);
								if (hdata != NULL)
								{
									char* data = (char*)GlobalLock(hdata);
									memcpy(data, utf16Str, utf16ByteLen);
									GlobalUnlock(hdata);
									if (!SetClipboardData(CF_UNICODETEXT, hdata))
									{
										GlobalFree(hdata);
									}
								}
							}
							
							// CF_TEXT / CF_OEMTEXT
							{
								int32_t clipboardValid = 0;
								// Is this a valid combination? Or will we lose data here?
								uint32_t codePage = CP_ACP;
								/*LCID localeId = GetSystemDefaultLCID();
								int32_t localeValid = 0;
								HANDLE hdataLocale = GlobalAlloc(GMEM_MOVEABLE, sizeof(LCID));
								if (hdataLocale != NULL)
								{
									LCID* pLocale = (LCID*)GlobalLock(hdataLocale);
									*pLocale = localeId;
									GlobalUnlock(hdataLocale);
									if (SetClipboardData(CF_LOCALE, hdataLocale))
									{
										localeValid = 1;
									}
									else
									{
										GlobalFree(hdataLocale);
									}
								}*/
								
								uint32_t codePageStrLen;
								char* codePageStr = utf16ToCodePage(codePage, utf16Str, utf16StrLen, &codePageStrLen);
								if (codePageStr != NULL)
								{
									HGLOBAL hdata = GlobalAlloc(GMEM_MOVEABLE, codePageStrLen);
									if (hdata != NULL)
									{
										char* data = (char*)GlobalLock(hdata);
										memcpy(data, codePageStr, codePageStrLen);
										GlobalUnlock(hdata);
										if (SetClipboardData(CF_TEXT, hdata))
										{
											clipboardValid = 1;
										}
										else
										{
											GlobalFree(hdata);
										}
									}
									free(codePageStr);
								}
								
								if (!clipboardValid)
								{
									EmptyClipboard();
								}
							}
						}
						CloseClipboard();
					}
				}
				break;
		}
	}
	else if (buffer[0] == 1)
	{
		// Get clipboard data
		if (OpenClipboard(NULL))
		{
			/*if (IsClipboardFormatAvailable(CF_BITMAP))
			{
				HANDLE clipboardData = GetClipboardData(CF_BITMAP);
				if (clipboardData != NULL)
				{
					HBITMAP hBitmap = (HBITMAP)clipboardData;
					if (hBitmap)
					{
						BITMAP bitmap;
						if (GetObject(hBitmap, sizeof(bitmap), &bitmap) && bitmap.bmBitsPixel == 32 &&
							bitmap.bmWidth > 0 && bitmap.bmHeight > 0)
						{
							int32_t imageWidth = bitmap.bmWidth;
							int32_t imageHeight = bitmap.bmHeight;
							int32_t buffSize = imageWidth * imageHeight * (bitmap.bmBitsPixel / 8);
							
							uint8_t* ptr = (uint8_t*)malloc(buffSize + 8);
							if (ptr != NULL)
							{
								((int32_t*)ptr)[0] = imageWidth;
								((int32_t*)ptr)[1] = imageHeight;
								uint8_t* imageDataPtr = ptr + 8;
							
								bitmap.bmBits = imageDataPtr;
								GetBitmapBits(hBitmap, buffSize, bitmap.bmBits);
							
								// BGRA -> RGBA
								for (int32_t i = 0; i < buffSize; i += 4)
								{
									uint8_t temp = imageDataPtr[i + 0];
									imageDataPtr[i + 0] = imageDataPtr[i + 2];//R
									// G is already in the correct place
									imageDataPtr[i + 2] = temp;//B
									//imageDataPtr[i + 3] = 0xFF; // CF_BITMAP ignores transparency
								}
								
								queuePacket_GetClipboardDataResponse(1, ptr, (uint32_t)buffSize);
								free(ptr);
							}
						}
					}
				}
			}
			else */if (IsClipboardFormatAvailable(CF_UNICODETEXT))
			{
				HANDLE clipboardData = GetClipboardData(CF_UNICODETEXT);
				if (clipboardData != NULL)
				{
					wchar_t* str = (wchar_t*)GlobalLock(clipboardData);
					if (str != NULL)
					{
						size_t strLen = wcslen(str);
						if (strLen > 0)
						{
							queuePacket_GetClipboardDataResponseUTF16(str, strLen);
						}
						GlobalUnlock(clipboardData);
					}
				}
			}
			else if ((IsClipboardFormatAvailable(CF_TEXT) && IsClipboardFormatAvailable(CF_LOCALE)) ||
				IsClipboardFormatAvailable(CF_OEMTEXT))
			{
				int32_t isOEM = !IsClipboardFormatAvailable(CF_TEXT);
				int32_t hasCodePage = 0;
				uint32_t codePage = 0;
				LCID localeId = 0;
				if (!IsClipboardFormatAvailable(CF_LOCALE))
				{
					HANDLE clipboardData = GetClipboardData(CF_LOCALE);
					if (clipboardData != NULL)
					{
						LCID* localePtr = (LCID*)GlobalLock(clipboardData);
						if (localePtr != NULL)
						{
							// NOTE: locale seems very broken on windows 95/98? (returns large values)
							// Useful macros: LANGIDFROMLCID, MAKELANGID, MAKELCID
							localeId = *localePtr;
							LCTYPE localeType;
							if (isOEM)
							{
								localeType = LOCALE_IDEFAULTCODEPAGE;
							}
							else
							{
								localeType = LOCALE_IDEFAULTANSICODEPAGE;
							}
							codePage = getLocaleCodePage(localeId, localeType);
							hasCodePage = 1;
							GlobalUnlock(clipboardData);
						}
					}
				}
				if (!hasCodePage)
				{
					if (isOEM)
					{
						codePage = GetOEMCP();
					}
					else
					{
						codePage = GetACP();
					}
					hasCodePage = 1;
				}
				
				if (hasCodePage)
				{
					HANDLE clipboardData = GetClipboardData(isOEM ? CF_OEMTEXT : CF_TEXT);
					if (clipboardData != NULL)
					{
						char* str = (char*)GlobalLock(clipboardData);
						if (str != NULL)
						{
							size_t strLen = GlobalSize(clipboardData);
							uint32_t utf16Len;
							wchar_t* utf16Str = codePageToUtf16(codePage, str, strLen, &utf16Len);
							if (utf16Str != NULL)
							{
								queuePacket_GetClipboardDataResponseUTF16(utf16Str, utf16Len);
								free(utf16Str);
							}
							GlobalUnlock(clipboardData);
						}
					}
				}
			}
			CloseClipboard();
		}
	}
}

void cancelFileTransfer()
{
	FileTransferItem* file = fileTransferFiles;
	while (file != NULL)
	{
		if (file->FileHandle != NULL)
		{
			fclose(file->FileHandle);
		}
	
		FileTransferItem* temp = file;
		file = file->Next;
		free(temp);
	}
	if (fileTransferDirection == FT_VM_TO_HOST)
	{
		queuePacket_GetFilesFromVMEnd(1);
	}
	fileTransferFiles = NULL;
	fileTransferDirection = -1;
}

void copyWin32FindDataW(WIN32_FIND_DATAA* src, WIN32_FIND_DATAW* dest)
{
	dest->dwFileAttributes = src->dwFileAttributes;
	dest->ftCreationTime = src->ftCreationTime;
	dest->ftLastAccessTime = src->ftLastAccessTime;
	dest->ftLastWriteTime = src->ftLastWriteTime;
	dest->nFileSizeHigh = src->nFileSizeHigh;
	dest->nFileSizeLow = src->nFileSizeLow;
	dest->dwReserved0 = src->dwReserved0;
	dest->dwReserved1 = src->dwReserved1;
	mbstowcs(dest->cFileName, src->cFileName, MAX_PATH);
	mbstowcs(dest->cAlternateFileName, src->cAlternateFileName, 14);
	//dest->dwFileType = src->dwFileType;
	//dest->dwCreatorType = src->dwCreatorType;
	//dest->wFinderFlags = src->wFinderFlags;
}

void findFilesForTransfer(const wchar_t* dir, FileTransferItem** prevItem)
{
	wchar_t searchPath[MAX_PATH];
	swprintf(searchPath, L"%s\\*", dir);

	WIN32_FIND_DATAW file;
	HANDLE hFind = NULL;
	if (g_isWindowsPlatformNT)
	{
		hFind = FindFirstFileW(searchPath, &file);
	}
	else
	{
		char searchPathA[MAX_PATH];
		wcstombs(searchPathA, searchPath, MAX_PATH);
		
		WIN32_FIND_DATAA fileA;
		hFind = FindFirstFileA(searchPathA, &fileA);
		copyWin32FindDataW(&fileA, &file);
	}
	if (hFind != INVALID_HANDLE_VALUE)
	{
		while (1)
		{
			int32_t skip = 0;
			if (file.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
			{
				// Ignore special dirs "." / ".."
				if (wcscmp(file.cFileName, L".") == 0 ||
					wcscmp(file.cFileName, L"..") == 0)
				{
					skip = 1;
				}
			}
			else
			{
				LARGE_INTEGER fileSize;
				fileSize.LowPart = file.nFileSizeLow;
				fileSize.HighPart = file.nFileSizeHigh;
				if (fileSize.QuadPart >= UINT32_MAX)
				{
					// Not handling large files (over 4GB)
					skip = 1;
				}
			}
		
			if (!skip)
			{
				FileTransferItem* item = malloc(sizeof(FileTransferItem));
				if (item != NULL)
				{
					item->Path[0] = 0;
					if (wcslen(dir) + wcslen(file.cFileName) < MAX_PATH)
					{
						wcscat(item->Path, dir);
						wcscat(item->Path, L"\\");
						wcscat(item->Path, file.cFileName);
					}
					
					item->FileHandle = NULL;
					item->IsDirectory = 0;
					item->Offset = 0;
					item->Length = 0;
					item->Next = NULL;
					if (*prevItem == NULL)
					{
						fileTransferFiles = item;
					}
					else
					{
						(*prevItem)->Next = item;
					}
					*prevItem = item;
	
					if (file.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
					{
						item->IsDirectory = 1;
						swprintf(searchPath, L"%s\\%s", dir, file.cFileName);
						findFilesForTransfer(searchPath, prevItem);
					}
					else
					{
						LARGE_INTEGER fileSize;
						fileSize.LowPart = file.nFileSizeLow;
						fileSize.HighPart = file.nFileSizeHigh;
						item->Length = fileSize.QuadPart;
					}
				}
			}
			
			if (g_isWindowsPlatformNT)
			{
				if (!FindNextFileW(hFind, &file))
				{
					break;
				}
			}
			else
			{
				WIN32_FIND_DATAA fileA;
				if (!FindNextFileA(hFind, &fileA))
				{
					break;
				}
				copyWin32FindDataW(&fileA, &file);
			}
		}
		FindClose(hFind);
	}
}

void processFilePacket(PacketData* packetData)
{
	uint8_t* buffer = packetData->Buffer;
	
	// Validate the file transfer state
	switch (buffer[0])
	{
		case FT_HOST_TO_VM:
		case FT_VM_TO_HOST:
			{
				if (fileTransferDirection != -1)
				{
					vmprintf("File transfer already in progress\n");
					return;
				}
			}
			break;
		case FT_DATA:
		case FT_END:
			{
				if (fileTransferDirection == -1)
				{
					return;
				}
			}
			break;
	}
	
	switch (buffer[0])
	{
		case FT_HOST_TO_VM:
			{
				if (g_isWindowsPlatformNT)
				{
					if (GetCurrentDirectoryW(MAX_PATH, fileTransferBaseDirectory))
					{
						wcscat(fileTransferBaseDirectory, L"\\");
						wcscat(fileTransferBaseDirectory, SHARED_FOLDER_NAME);
						wcscat(fileTransferBaseDirectory, L"\\");
						CreateDirectoryW(fileTransferBaseDirectory, NULL);
					}
					else
					{
						fileTransferBaseDirectory[0] = 0;
					}
				}
				else
				{
					char tempStr[MAX_PATH];
					if (GetCurrentDirectoryA(MAX_PATH, tempStr))
					{
						mbstowcs(fileTransferBaseDirectory, tempStr, MAX_PATH);
						wcscat(fileTransferBaseDirectory, L"\\");
						wcscat(fileTransferBaseDirectory, SHARED_FOLDER_NAME);
						wcscat(fileTransferBaseDirectory, L"\\");
						wcstombs(tempStr, fileTransferBaseDirectory, MAX_PATH);
						CreateDirectoryA(tempStr, NULL);
					}
					else
					{
						fileTransferBaseDirectory[0] = 0;
					}
				}
				fileTransferDirection = FT_HOST_TO_VM;
			}
			break;
		case FT_VM_TO_HOST:
			{
				// GetOpenFileName (comdlg32.dll) could be used here but on Windows 95/98 you are
				// limited to selecting files (no folder selection)
				
				wchar_t searchPath[MAX_PATH];
				if (g_isWindowsPlatformNT)
				{
					if (GetCurrentDirectoryW(MAX_PATH, searchPath))
					{
						wcscat(searchPath, L"\\");
						wcscat(searchPath, SHARED_FOLDER_NAME);
						FileTransferItem* prevItem = NULL;
						findFilesForTransfer(searchPath, &prevItem);
					}
				}
				else
				{
					char tempStr[MAX_PATH];
					if (GetCurrentDirectoryA(MAX_PATH, tempStr))
					{
						mbstowcs(searchPath, tempStr, MAX_PATH);
						wcscat(searchPath, L"\\");
						wcscat(searchPath, SHARED_FOLDER_NAME);
						FileTransferItem* prevItem = NULL;
						findFilesForTransfer(searchPath, &prevItem);
					}
				}
				if (fileTransferFiles != NULL)
				{
					fileTransferDirection = FT_VM_TO_HOST;
					queuePacket_GetFilesFromVMResponse();
					queuePacket_GetFilesFromVMDataNext();
				}
				else
				{
					queuePacket_GetFilesFromVMResponse();
				}
			}
			break;
		case FT_DATA:
			{
				if (fileTransferDirection != FT_HOST_TO_VM)
				{
					return;
				}
			
				int32_t pOffset = 1;
				uint32_t offset = *(uint32_t*)(buffer + pOffset);
				pOffset += 4;
				uint32_t length = *(uint32_t*)(buffer + pOffset);
				pOffset += 4;
				if (offset == 0)
				{
					if (fileTransferFiles != NULL)
					{
						if (fileTransferFiles->Next != NULL)
						{
							// We should only be dealing with 1 file at a time when getting the files.
							cancelFileTransfer();
							return;
						}

						if (fileTransferFiles->FileHandle != NULL)
						{
							fclose(fileTransferFiles->FileHandle);
						}
					}
					else
					{
						// This will be used for all files (freed after transfer is complete)
						fileTransferFiles = malloc(sizeof(FileTransferItem));
						if (fileTransferFiles == NULL)
						{
							// TODO: Actually make a cancel request to JS
							cancelFileTransfer();
							return;
						}
					}
					fileTransferFiles->FileHandle = NULL;
					fileTransferFiles->IsDirectory = 0;
					fileTransferFiles->Offset = offset;
					fileTransferFiles->Length = length;
					fileTransferFiles->Next = NULL;
					memset(fileTransferFiles->Path, 0, sizeof(fileTransferFiles->Path));
					wcscat(fileTransferFiles->Path, fileTransferBaseDirectory);// Hopefully exists
					int32_t pathOffset = wcslen(fileTransferBaseDirectory);
					
					fileTransferFiles->IsDirectory = *(uint8_t*)(buffer + pOffset);
					pOffset += 1;
					int32_t pathLen = *(int32_t*)(buffer + pOffset);
					pOffset += 4;
					for (int32_t i = 0; i < pathLen; i++)
					{
						fileTransferFiles->Path[pathOffset + i] = *(wchar_t*)(buffer + pOffset);
						if (fileTransferFiles->Path[pathOffset + i] == L'/')
						{
							fileTransferFiles->Path[pathOffset + i] = L'\\';
						}
						pOffset += sizeof(wchar_t);
					}
					
					// Create the directory
					wchar_t dir[MAX_PATH];
					char dirA[MAX_PATH];
					wchar_t* start = fileTransferFiles->Path;
					wchar_t* end = wcschr(fileTransferFiles->Path + pathOffset, L'\\');
					wchar_t* last = NULL;
					int32_t totalPathLen = wcslen(fileTransferFiles->Path);
					while (end != NULL)
					{
						last = end + 1;
						int32_t dirLen = (end - start) + 1;
						wcsncpy(dir, start, dirLen);
						dir[dirLen] = 0;
						if (g_isWindowsPlatformNT)
						{
							CreateDirectoryW(dir, NULL);
						}
						else
						{
							wcstombs(dirA, dir, MAX_PATH);
							CreateDirectoryA(dirA, NULL);
						}
						end = wcschr(++end, L'\\');
					}
					if (fileTransferFiles->IsDirectory && (last == NULL || last - start != totalPathLen))
					{
						int32_t dirLen = totalPathLen;
						wcsncpy(dir, start, dirLen);
						dir[dirLen] = 0;
						if (g_isWindowsPlatformNT)
						{
							CreateDirectoryW(dir, NULL);
						}
						else
						{
							wcstombs(dirA, dir, MAX_PATH);
							CreateDirectoryA(dirA, NULL);
						}
					}
					
					if (!fileTransferFiles->IsDirectory)
					{
						if (g_isWindowsPlatformNT)
						{
							fileTransferFiles->FileHandle = _wfopen(fileTransferFiles->Path, L"wb+");
						}
						else
						{
							char tempStr[MAX_PATH];
							wcstombs(tempStr, fileTransferFiles->Path, MAX_PATH);
							fileTransferFiles->FileHandle = fopen(tempStr, "wb+");
						}
					}
				}
				else if (fileTransferFiles == NULL)
				{
					// File transfer cancelled?
					return;
				}
				
				int32_t dataSize = *(int32_t*)(buffer + pOffset);
				pOffset += 4;
				
				if (dataSize > 0 && fileTransferFiles->FileHandle != NULL)
				{
					// TODO: Error checking
					fseek(fileTransferFiles->FileHandle, offset, SEEK_SET);
					fwrite(buffer + pOffset, 1, dataSize, fileTransferFiles->FileHandle);
				}
			}
			break;
		case FT_END:
			{
				cancelFileTransfer();
			}
			break;
	}
}

void processPacket(PacketType packetType, PacketData* packetData)
{
	switch (packetType)
	{
		case PT_MiscData:
			switch (packetData->Buffer[0])
			{
				case MP_Clipboard:
					processClipboardPacket(packetData);
					break;
				case MP_KeepAlive:
					g_lastKeepAlive = GetTickCount();
					break;
			}
			break;
		case PT_FileData:
			processFilePacket(packetData);
			break;
		case PT_NetworkData:
			processNetworkPacket(packetData);
			break;
	}
}

int32_t processPacketsImpl()
{
	if (isDisconnected())
	{
		return 0;
	}
	int32_t dataCount = 0;
	for (int32_t i = 0; i < PT_MAX; i++)
	{
		PacketType packetType = (PacketType)i;
		int32_t readerOffset = packetOffsets[(i * 2) + 0];
		int32_t writerOffset = packetOffsets[(i * 2) + 1];
		uint8_t* readerData = g_sharedMemory + readerOffset;
		uint8_t* writerData = g_sharedMemory + writerOffset;
		uint32_t queuedReaders = *(uint32_t*)readerData;
		uint32_t queuedWriters = *(uint32_t*)writerData;
		
		if (queuedReaders > 0)
		{
			uint32_t pOffset = 0;
			for (int32_t j = 0; j < queuedReaders; j++)
			{
				uint8_t cancel = *(uint8_t*)(readerData + pOffset + 4);
				uint32_t offset = *(int32_t*)(readerData + pOffset + 5);
				uint32_t totalLen = *(int32_t*)(readerData + pOffset + 9);
				uint32_t chunkLen = *(int32_t*)(readerData + pOffset + 13);
				uint8_t isComplete = offset + chunkLen >= totalLen;
				g_totalBytesHostToVm += PACKET_BLOCK_HEADER_SIZE + chunkLen;
				if (cancel)
				{
					PacketData* packetData = packetReaders[i];
					if (packetData != NULL)
					{
						assert(packetData->Next == NULL);
						free(packetData->Buffer);
						free(packetData);
						packetReaders[i] = NULL;
					}
				}
				else if (totalLen > 0)
				{
					PacketData* packetData = packetReaders[i];
					if (offset == 0)
					{
						g_totalPacketsHostToVm++;
						assert(packetData == NULL);
						packetData = calloc(1, sizeof(PacketData));
						if (packetData == NULL)
						{
							forceDisconnect();
							return;
						}
						packetData->Buffer = (uint8_t*)malloc(totalLen);
						if (packetData->Buffer == NULL)
						{
							forceDisconnect();
							return;
						}
						packetData->Offset = 0;
						packetData->Length = totalLen;
						packetReaders[i] = packetData;
					}
					if (packetData != NULL)
					{
						assert(packetData->Next == NULL);
						assert(offset + chunkLen <= packetData->Length);
						packetData->Offset = offset;
						memcpy(packetData->Buffer + packetData->Offset, readerData + pOffset + PACKET_BLOCK_HEADER_SIZE, chunkLen);
						if (isComplete)
						{
							//vmprintf("Received packet of length %d\n", packetData->Length);
							processPacket(packetType, packetData);
							free(packetData->Buffer);
							free(packetData);
							packetReaders[i] = NULL;
						}
					}
				}
				pOffset += PACKET_BLOCK_HEADER_SIZE + chunkLen;
			}
			*(uint32_t*)readerData = 0;
		}
		if (queuedWriters == 0)
		{
			PacketData* packetData = packetWriters[i];
			if (packetData != NULL)
			{
				uint32_t pOffset = 0;
				while (pOffset < PACKET_BLOCK_SIZE && packetData != NULL)
				{
					if (pOffset != 0 && packetData->Length + PACKET_BLOCK_HEADER_SIZE >= PACKET_BLOCK_SIZE - pOffset)
					{
						break;
					}
					
					uint32_t chunkLen = min(packetData->Length - packetData->Offset, PACKET_BLOCK_DATA_SIZE);
					uint8_t* buffer = packetData->Buffer + packetData->Offset;
					
					*(uint8_t*)(writerData + pOffset + 4) = packetData->Cancel;
					*(uint32_t*)(writerData + pOffset + 5) = packetData->Offset;
					*(uint32_t*)(writerData + pOffset + 9) = packetData->Length;
					*(uint32_t*)(writerData + pOffset + 13) = chunkLen;
					memcpy(writerData + pOffset + PACKET_BLOCK_HEADER_SIZE, buffer, chunkLen);
					
					g_totalBytesVmToHost += PACKET_BLOCK_HEADER_SIZE + chunkLen;
					
					packetData->Offset += chunkLen;
					if (packetData->Offset >= packetData->Length)
					{
						g_totalPacketsVmToHost++;
						packetWriters[i] = packetData->Next;
						switch (packetType)
						{
							case PT_FileData:
								{
									if (fileTransferDirection == FT_VM_TO_HOST && packetData->Buffer[0] == FT_DATA)
									{
										queuePacket_GetFilesFromVMDataNext();
									}
								}
								break;
						}
						if (packetData->RequiresFree)
						{
							free(packetData->Buffer);
						}
						free(packetData);
					}
					
					pOffset += PACKET_BLOCK_HEADER_SIZE + chunkLen;
					queuedWriters++;
					packetData = packetWriters[i];
				}
				*(uint32_t*)writerData = queuedWriters;
			}
		}
		dataCount += queuedReaders + queuedWriters;
	}
	return dataCount;
}

int32_t processPackets()
{
	EnterCriticalSection(&packetCriticalSection);
	int32_t result = processPacketsImpl();
	LeaveCriticalSection(&packetCriticalSection);
	return result;
}

ProxyConnection* getNextProxyConnection()
{
	int32_t count = 0;
	ProxyConnection* connection = NULL;
	while (connection == NULL || connection->IsConnected)
	{
		if (count >= MAX_PROXY_CONNECTIONS)
		{
			return NULL;
		}
		if (nextProxyConnectionIndex >= MAX_PROXY_CONNECTIONS)
		{
			nextProxyConnectionIndex = 0;
		}
		connection = &proxyConnections[nextProxyConnectionIndex];
		connection->Index = nextProxyConnectionIndex;
		nextProxyConnectionIndex++;
		count++;
	}
	return connection;
}

void freeProxyConnection(ProxyConnection* connection)
{
	assert(connection->Index >= 0 && connection->Index < MAX_PROXY_CONNECTIONS);
	if (!isDisconnected())
	{
		queuePacket_ProxyConnectionDisconnected(connection);
	}
	memset(connection, 0, sizeof(ProxyConnection));
}

int32_t validateProxyConnection(ProxyConnection* connection, SOCKET socket)
{
	EnterCriticalSection(&packetCriticalSection);
	int32_t result = connection->IsConnected && connection->Socket == socket;
	LeaveCriticalSection(&packetCriticalSection);
	return result;
}

DWORD WINAPI proxyServerConnectionThread(LPVOID lpParam)
{
	// TODO: validateProxyConnection should probably be more thread safe
	ProxyConnection* connection = (ProxyConnection*)lpParam;
	SOCKET clientSocket = connection->Socket;
	
	EnterCriticalSection(&packetCriticalSection);
	if (validateProxyConnection(connection, clientSocket))
	{
		queuePacket_ProxyConnectionConnect(connection);
	}
	LeaveCriticalSection(&packetCriticalSection);
	
	while (!isDisconnected() && validateProxyConnection(connection, clientSocket))
	{
		const buffSize = 4096;
		uint8_t buff[buffSize];
		
		int32_t readBytes = 0;
		while ((readBytes = recv(clientSocket, buff, buffSize, 0)) > 0)
		{
			vmprintf("Socket recv: %d\n", readBytes);
			
			EnterCriticalSection(&packetCriticalSection);
			if (validateProxyConnection(connection, clientSocket))
			{
				queuePacket_ProxyConnectionRecv(connection, buff, readBytes);
			}
			LeaveCriticalSection(&packetCriticalSection);
		}
		
		if (readBytes <= 0)
		{
			EnterCriticalSection(&packetCriticalSection);
			if (validateProxyConnection(connection, clientSocket))
			{
				queuePacket_ProxyConnectionDisconnected(connection);
				freeProxyConnection(connection);
				shutdown(clientSocket, SD_BOTH);
				closesocket(clientSocket);
			}
			LeaveCriticalSection(&packetCriticalSection);
			break;
		}
	}
	vmprintf("Client disconnected\n");
	return 0;
}

DWORD WINAPI proxyServerThreadUdp(LPVOID lpParam)
{
	SOCKET serverSocket = (SOCKET)lpParam;
	if (serverSocket == INVALID_SOCKET)
	{
		vmprintf("Invalid SOCKET param -1 on proxy server thread\n");
		return 0;
	}
	NetworkType networkType = -1;
	for (int32_t i = 0; i < NT_MAX; i++)
	{
		if (serverSocket == serverSockets[i])
		{
			networkType = (NetworkType)i;
		}
	}
	if (networkType == -1)
	{
		vmprintf("Unknown server type for UDP proxy server\n");
		return 0;
	}
	
	struct sockaddr_in from;
	int32_t fromLen = sizeof(from);
	
	int32_t headerSize = sizeof(from) + 4;
	int32_t buffDataSize = 512;
	int32_t buffSize = buffDataSize;
	buffSize += headerSize;
	uint8_t buff[buffSize];
	
	*(uint32_t*)(buff) = sizeof(from);
	uint8_t* buffData = buff + headerSize;
	
	while (!isDisconnected())
	{
		int32_t readBytes = recvfrom(serverSocket, buffData, buffDataSize, 0, (struct sockaddr *)&from, &fromLen);
		if (readBytes > 0)
		{
			memcpy(buff + 4, &from, sizeof(from));
			queuePacket_ProxyConnectionRecvUdp(networkType, buff, readBytes + headerSize);
		}
		else if (readBytes == SOCKET_ERROR)
		{
			Sleep(100);
		}
	}
	return 0;
}

DWORD WINAPI proxyServerThread(LPVOID lpParam)
{
	SOCKET serverSocket = (SOCKET)lpParam;
	if (serverSocket == INVALID_SOCKET)
	{
		vmprintf("Invalid SOCKET param -1 on proxy server thread\n");
		return 0;
	}
	NetworkType networkType = -1;
	for (int32_t i = 0; i < NT_MAX; i++)
	{
		if (serverSocket == serverSockets[i])
		{
			networkType = (NetworkType)i;
		}
	}
	if (networkType == -1)
	{
		vmprintf("Unknown server type for UDP proxy server\n");
		return 0;
	}
	
	int32_t numFails = 0;
	while (!isDisconnected())
	{
		struct sockaddr_in clientAddress;
		int32_t clientAddressLen = (int32_t)sizeof(struct sockaddr);
		SOCKET clientSocket = accept(serverSocket, (struct sockaddr *)&clientAddress, &clientAddressLen);
		if (clientSocket == INVALID_SOCKET)
		{
			vmprintf("Proxy server failed to accept client. Network type: %d error: %d \n", networkType, WSAGetLastError());
			if (numFails++ >= 5)
			{
				break;
			}
		}
		else
		{
			EnterCriticalSection(&packetCriticalSection);
			numFails = 0;
			ProxyConnection* connection = getNextProxyConnection();
			if (connection != NULL)
			{
				vmprintf("Client connected\n");
				connection->Socket = clientSocket;
				connection->IsConnected = 1;
				connection->NetworkType = (uint8_t)networkType;
				//int32_t flags = 1;
				//setsockopt(clientSocket, SOL_SOCKET, SO_KEEPALIVE, (char*)&flags, sizeof(flags));
				CreateThread(NULL, 0, proxyServerConnectionThread, (LPVOID)connection, 0, NULL);
			}
			else
			{
				vmprintf("Failed to find a free slot for proxy connection\n");
				closesocket(clientSocket);
			}
			LeaveCriticalSection(&packetCriticalSection);
		}
	}
	return 0;
}

void startProxyServer(NetworkType networkType, SOCKET* serverSocketPtr, uint16_t port)
{
	struct sockaddr_in serverAddress = { 0 };
	serverAddress.sin_family = AF_INET;
	serverAddress.sin_port = htons(port);
	serverAddress.sin_addr.s_addr = INADDR_ANY;
	
	int32_t udp = (port == PROXY_DNS_PORT);
	SOCKET serverSocket = socket(AF_INET, udp ? SOCK_DGRAM : SOCK_STREAM, 0);
	if (serverSocket == INVALID_SOCKET)
	{
		vmprintf("Failed to create socket for proxy server on port %d. Error code: %d\n", (int32_t)port, WSAGetLastError());
		return;
	}
	if (bind(serverSocket, (struct sockaddr *)&serverAddress, sizeof(serverAddress)) == -1)
	{
		vmprintf("Failed to bind server on port %d\n", (int32_t)port);
		closesocket(serverSocket);
		return;
	}
	if (!udp && listen(serverSocket, 100) == -1)
	{
		vmprintf("Failed to start server on port %d\n", (int32_t)port);
		closesocket(serverSocket);
		return;
	}
	*serverSocketPtr = serverSocket;
	if (udp)
	{
		CreateThread(NULL, 0, proxyServerThreadUdp, (LPVOID)serverSocket, 0, NULL);
	}
	else
	{
		CreateThread(NULL, 0, proxyServerThread, (LPVOID)serverSocket, 0, NULL);
	}
}

void startProxyServers()
{
	// To disable servers comment out these lines (they default to 0)
	serverSocketsPorts[NT_HttpProxy] = PROXY_HTTP_PORT;
	serverSocketsPorts[NT_HttpsProxy] = PROXY_HTTPS_PORT;
	serverSocketsPorts[NT_DnsProxy] = PROXY_DNS_PORT;
	serverSocketsPorts[NT_SocksProxy] = PROXY_SOCKS_PORT;
	serverSocketsPorts[NT_HttpProxyEmulated] = PROXY_HTTP_EMULATED_PORT;
	serverSocketsPorts[NT_HttpsProxyEmulated] = PROXY_HTTPS_EMULATED_PORT;
	for (int32_t i = 0; i < NT_MAX; i++)
	{
		if (serverSocketsPorts[i])
		{
			startProxyServer((NetworkType)i, &serverSockets[i], serverSocketsPorts[i]);
		}
	}
}

LRESULT CALLBACK wndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
	switch (msg)
	{
		case WM_DESTROY:
			PostQuitMessage(0);
			return 0;
		case WM_PAINT:
			{
				RECT clientRect;
				RECT updateRect;
				if (!GetUpdateRect(hwnd, &updateRect, TRUE) || !GetClientRect(hwnd, &clientRect))
				{
					return 0;
				}
				else if (updateRect.left != 0 || updateRect.top != 0 ||
					updateRect.right != clientRect.right || updateRect.bottom != clientRect.bottom)
				{
					if (updateRect.left == 0 && updateRect.top == 0 && updateRect.right == 0 && updateRect.bottom == 0)
					{
						return 0;
					}
					// Only doing hacky manual drawing (and only full client area refreshes).
					InvalidateRect(hwnd, NULL, TRUE);
					return 0;
				}
				
				PAINTSTRUCT ps;
				HDC hdc = BeginPaint(hwnd, &ps);
				
				// Draw the background
				FillRect(hdc, &clientRect, (HBRUSH)(COLOR_WINDOW+1));
				
				// Draw text
				char str[1024] = {0};
				sprintf(str, "Transferring files: %s\n\nBytes\nVmToHost: %I64u\nHostToVm: %I64u\n\nPackets\nVmToHost: %I64u\nHostToVm: %I64u",
					(fileTransferDirection == -1 ? "no" : "yes"), g_totalBytesVmToHost, g_totalBytesHostToVm,
					g_totalPacketsVmToHost, g_totalPacketsHostToVm);
				DrawString(hdc, str);
				
				EndPaint(hwnd, &ps);
			}
			return 0;
		case WM_SIZE:
			{
				InvalidateRect(hwnd, NULL, TRUE);
			}
			break;
	}
	return DefWindowProc(hwnd, msg, wParam, lParam);
}

void runUI()
{
	const char* wndClassName = "vmtoolsWindowClass";
	HANDLE hInstance = GetModuleHandle(NULL);
	
	WNDCLASS wc = {0};
	wc.lpfnWndProc = wndProc;
	wc.hInstance = hInstance;
	wc.lpszClassName = wndClassName;
	wc.hCursor = LoadCursor(NULL, IDC_ARROW);
	
	if (!RegisterClass(&wc))
	{
		return;
	}

	HWND hwnd = CreateWindowEx(
		0,
		wndClassName,
		"vmtools",
		WS_OVERLAPPEDWINDOW,
		CW_USEDEFAULT, CW_USEDEFAULT,
		250, 200,//CW_USEDEFAULT, CW_USEDEFAULT,
		NULL,
		NULL,
		hInstance,
		NULL);
	if (hwnd == NULL)
	{
		return;
	}
	ShowWindow(hwnd, SW_SHOWDEFAULT);
	
	// GetConsoleWindow() is NT 5.0+ (Windows 2000)
	HWND consoleWindow = FindWindowA("ConsoleWindowClass", NULL);
	if (consoleWindow != NULL)
	{
		//ShowWindow(consoleWindow, SW_HIDE);
	}
	
	MSG msg = {0};
	while (msg.message != WM_QUIT)
	{
		while (PeekMessage(&msg, NULL, 0, 0, PM_REMOVE))
		{
			TranslateMessage(&msg);
			DispatchMessage(&msg);
		}
		
		if (g_sharedMemory != NULL)
		{
			if (((uint32_t*)g_sharedMemory)[0] == hostMagicDead ||
				((uint32_t*)g_sharedMemory)[1] == guestMagicDead)
			{
				PostQuitMessage(0);
			}
			else
			{
				while (processPackets())
				{
				}
				
				int32_t tick = GetTickCount();
				
#if USE_KEEP_ALIVE
				// First check is to avoid errors on tick overflow
				if (g_lastKeepAlive + KEEP_ALIVE_TIMEOUT > g_lastKeepAlive &&
					g_lastKeepAlive + KEEP_ALIVE_TIMEOUT < tick)
				{
					PostQuitMessage(0);
				}
				
				if (g_lastSendKeepAlive + KEEP_ALIVE_DELAY < g_lastSendKeepAlive ||
					g_lastSendKeepAlive + KEEP_ALIVE_DELAY < tick)
				{
					g_lastSendKeepAlive = tick;
					queuePacket_KeepAlive();
				}
#endif
				
				if (g_lastRefreshUI + REFRESH_UI_DELAY < g_lastRefreshUI ||
					g_lastRefreshUI + REFRESH_UI_DELAY < tick)
				{
					g_lastRefreshUI = tick;
					InvalidateRect(hwnd, NULL, TRUE);
				}
			}
		}
		
		Sleep(1);
	}
}

void strcatBlockId(char* buffer, int32_t blockId)
{
	char blockStr[10] = { 0 };
	sprintf(blockStr, "%07d", blockId);// 7 digits
	strcat(buffer, blockStr);
}

void main()
{
	g_isWindowsPlatformNT = isWindowsPlatformNT();

	vmprintf("Allocating buffer...\n");
	
	// +1 block to ensure we start at an aligned address
	// +1 for a null terminator
	int32_t bufferLength = (g_blockSize * (g_numBlocks + 1)) + 1;
	char* bufferBaseAddress = (char*)calloc(1, bufferLength);
	if (!bufferBaseAddress)
	{
		vmprintf("ERR_nomem\n");
		getchar();
		return;
	}
	// Align the address
	size_t addr = (size_t)bufferBaseAddress;
	size_t remain = addr % g_blockSize;
	if (remain != 0)
	{
		addr += g_blockSize - remain;
	}
	char* buffer = (char*)addr;
	
	char* p = buffer;
	for (int32_t i = 0; i < g_numBlocks; i++)
	{
		strcat(p, "!vM!BlK:"); p+=8;
		strcatBlockId(p, i); p+=7;
		strcat(p, "[hDr]"); p+=5;
		
		memset(p, 'M', g_blockSize - g_blockHeaderFooterLenTotal);
		p += (g_blockSize - g_blockHeaderFooterLenTotal);
		
		strcat(p, "!vM!BlK:"); p+=8;
		strcatBlockId(p, i); p+=7;
		strcat(p, "[fTr]"); p+=5;
	}
	
	g_sharedMemory = (uint8_t*)(buffer);
	g_sharedData = (uint8_t*)(buffer + g_sharedDataOffset);
	
	// Now we have allocated the memory, signal the stub (if it exists)
	HANDLE waitForProcessEvent = OpenEvent(EVENT_MODIFY_STATE, FALSE, "vmtools_stub");
	if (waitForProcessEvent != NULL)
	{
		SetEvent(waitForProcessEvent);
	}
	
	initPacketOffsets();
	InitializeCriticalSection(&packetCriticalSection);

	vmprintf("Connecting...\n");
#if !USE_CONSOLE
	if (waitForProcessEvent == NULL)
	{
		// The console isn't available, and this wasn't launched by the stub. Show a message box
		// to indicate that vmtools is entering the connecting state.
		MessageBox(NULL, "Connecting... (press OK)\n", "", 0);
	}
#endif
	int32_t foundHost = 0;
	while (1)
	{
		if (!foundHost)
		{
			if (((uint32_t*)buffer)[0] == hostMagicComm)
			{
				foundHost = 1;
				((uint32_t*)buffer)[1] = guestMagicComm;
				vmprintf("Connected.\n");
				break;
			}
			else if (((uint32_t*)buffer)[0] == hostMagicDead)
			{
				break;
			}
		}
		Sleep(500);
	}
	
	g_lastRefreshUI = g_lastSendKeepAlive = g_lastKeepAlive = GetTickCount();
	
	WSADATA wsaData;
	int32_t wsaStartupResult = -1;
	if (foundHost)
	{
		wsaStartupResult = WSAStartup(MAKEWORD(2,2), &wsaData);
		if (wsaStartupResult == 0)
		{
			startProxyServers();
		}
		else
		{
			vmprintf("WSAStartup failed. Result: %d\n", wsaStartupResult);
		}
		runUI();
	}
	
	((uint32_t*)buffer)[1] = guestMagicDead;
	
	vmprintf("Finished.\n");
	if (foundHost)
	{
		vmprintf("Waiting for host to disconnect...\n");
		while (((uint32_t*)buffer)[0] != hostMagicDead)
		{
			Sleep(500);
		}
	}
	
	if (foundHost)
	{
		EnterCriticalSection(&packetCriticalSection);
		for (int32_t i = 0; i < MAX_PROXY_CONNECTIONS; i++)
		{
			ProxyConnection* connection = &proxyConnections[i];
			if (connection->IsConnected && connection->Socket != NULL)
			{
				SOCKET connectionSocket = connection->Socket;
				freeProxyConnection(connection);
				shutdown(connectionSocket, SD_BOTH);
				closesocket(connectionSocket);
			}
		}
		if (wsaStartupResult == 0)
		{
			WSACleanup();
		}
		LeaveCriticalSection(&packetCriticalSection);
	}
	
	EnterCriticalSection(&packetCriticalSection);
	g_sharedMemory = NULL;
	g_sharedData = NULL;
	LeaveCriticalSection(&packetCriticalSection);
	
	// Not going to free up this critical section so that threads can keep using it
	// after this point. Let the OS clean it up when the process exits.
	//DeleteCriticalSection(&packetCriticalSection);
	
	memset(bufferBaseAddress, 0, bufferLength);
	free(bufferBaseAddress);
	
	vmprintf("Closing...\n");
#if USE_CONSOLE
	Sleep(1000);
#else
	MessageBox(NULL, "Closing... (press OK)", "", 0);
#endif
}