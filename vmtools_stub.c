// compile without console: tcc vmtools_stub.c lib/user32.def -Wl,-subsystem=windows -DUSE_CONSOLE=0
// compile with console: tcc vmtools_stub.c -DUSE_CONSOLE=1
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <windows.h>

#if USE_CONSOLE
#define vmprintf(str, ...) printf(str, ##__VA_ARGS__)
#else
#define vmprintf(str, ...) { char vmprintfStr[1024]; sprintf(vmprintfStr, str, ##__VA_ARGS__); MessageBox(NULL, vmprintfStr, "", 0); }
#endif

const uint32_t hostMagicComm = 0xE2B13904;// States the host is ready for communication
const uint32_t hostMagicXfer = 0x8D93F023;// States the host has transferred the main exe into the buffer
const uint32_t hostMagicDead = 0x152339D9;// States the host no longer exists
const uint32_t guestMagicComm = 0x3904FEBB;// States the guest sees the host, and it can be used for communication
const uint32_t guestMagicXfer = 0x16222FED;// States the guest sees the host, and it wants to the host to transfer the main exe
const uint32_t guestMagicDead = 0x1B880C2C;// States the guest no longer exists

const int32_t blockSize = 4096;
const int32_t numBlocks = 256;
const int32_t blockHeaderFooterLen = 20;
const int32_t blockHeaderFooterLenTotal = 40;//blockHeaderFooterLen * 2;

void strcatBlockId(char* buffer, int32_t blockId)
{
	char blockStr[10] = { 0 };
	sprintf(blockStr, "%07d", blockId);// 7 digits
	strcat(buffer, blockStr);
}

void main()
{
#if USE_CONSOLE
	vmprintf("Allocating buffer...\n");
#endif

	// +1 block to ensure we start at an aligned address
	// +1 for a null terminator
	int32_t bufferLength = (blockSize * (numBlocks + 1)) + 1;
	char* bufferBaseAddress = (char*)calloc(1, bufferLength);
	if (!bufferBaseAddress)
	{
		vmprintf("ERR_nomem\n");
		getchar();
		return;
	}
	// Align the address
	size_t addr = (size_t)bufferBaseAddress;
	size_t remain = addr % blockSize;
	if (remain != 0)
	{
		addr += blockSize - remain;
	}
	char* buffer = (char*)addr;
	
	char* p = buffer;
	for (int32_t i = 0; i < numBlocks; i++)
	{
		strcat(p, "!vM!BlK:"); p+=8;
		strcatBlockId(p, i); p+=7;
		strcat(p, "[hDr]"); p+=5;
		
		memset(p, 'M', blockSize - blockHeaderFooterLenTotal);
		p += (blockSize - blockHeaderFooterLenTotal);
		
		strcat(p, "!vM!BlK:"); p+=8;
		strcatBlockId(p, i); p+=7;
		strcat(p, "[fTr]"); p+=5;
	}
	
#if USE_CONSOLE
	vmprintf("Connecting...\n");
#else
	vmprintf("Connecting... (press OK)\n");
#endif
	int32_t foundHost = 0;
	while (1)
	{
		if (!foundHost)
		{
			if (((uint32_t*)buffer)[0] == hostMagicComm)
			{
				foundHost = 1;
				((uint32_t*)buffer)[1] = guestMagicXfer;
#if USE_CONSOLE
				vmprintf("Connected.\n");
#endif
			}
			else if (((uint32_t*)buffer)[0] == hostMagicXfer)
			{
				vmprintf("ERR_hostMagicXfer\n");
				break;
			}
			else if (((uint32_t*)buffer)[0] == hostMagicDead)
			{
				vmprintf("ERR_hostMagicDead(1)\n");
				break;
			}
		}
		else
		{
			if (((uint32_t*)buffer)[0] == hostMagicXfer)
			{
				int32_t fileByteCount = ((int32_t*)buffer)[2];
				if (fileByteCount > 0)
				{
					// Save the bytes to an .exe, then run the .exe
					// Data comes after the 2 headers + data length
					char* fileBuffer = (char*)(buffer + 12);
					if (fileByteCount <= 2 || fileBuffer[0] != 'M' || fileBuffer[1] != 'Z')
					{
						vmprintf("ERR_fileNotExe\n");
					}
					else
					{
						// Use an event to ensure the target process is fully running
						HANDLE waitForProcessEvent = CreateEvent(NULL, FALSE, FALSE, "vmtools_stub");
					
						FILE* fp = fopen("vmtools.exe", "wb+");
						fwrite(fileBuffer, fileByteCount, 1, fp);
						fclose(fp);
					
						STARTUPINFO si = {0};
						PROCESS_INFORMATION pi = {0};
						si.cb = sizeof(STARTUPINFO);
						if (CreateProcess("vmtools.exe", NULL, NULL, NULL, FALSE, CREATE_NEW_CONSOLE, NULL, NULL, &si, &pi))
						{
							WaitForSingleObject(waitForProcessEvent, 20000);// Wait up to 20 seconds
							CloseHandle(pi.hProcess);
							CloseHandle(pi.hThread);
						}
					}
					break;
				}
				else
				{
					vmprintf("ERR_invalidFileLen(%d)\n", fileByteCount);
					break;
				}
			}
			else if (((uint32_t*)buffer)[0] == hostMagicDead)
			{
				vmprintf("ERR_hostMagicDead(2)\n");
				break;
			}
		}
		Sleep(500);
	}
	
	((uint32_t*)buffer)[1] = guestMagicDead;
	
#if USE_CONSOLE
	vmprintf("Done.\n");
#endif
	if (foundHost)
	{
#if USE_CONSOLE
		vmprintf("Disconnecting...\n");
#endif
		while (((uint32_t*)buffer)[0] != hostMagicDead)
		{
			Sleep(500);
		}
	}
	
	memset(bufferBaseAddress, 0, bufferLength);
	free(bufferBaseAddress);
	
#if USE_CONSOLE
	vmprintf("Done.\n");
#endif
}