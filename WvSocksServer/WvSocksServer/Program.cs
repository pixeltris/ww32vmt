using Fleck;
using Mentalis.Proxy.Socks;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace WvSocksServer
{
    class Program
    {
        static void Main(string[] args)
        {
            // sockets
            const int socksPort = 961;
            const int httpPort = 962;
            const int httpsPort = 963;
            // websockets
            const int webSockPort = 861;
            const int webSockDnsPort = 862;
            const int webSockHttpPort = 863;
            const int webSockHttpsPort = 864;
            int dnsTimeout = 30000;
            string wsUrl = "ws://0.0.0.0";

            Dictionary<int, int> simpleTcpProxyPorts = new Dictionary<int, int>()
            {
                { webSockPort, socksPort },
                { webSockHttpPort, httpPort },
                { webSockHttpsPort, httpsPort },
            };
            // This is mostly to keep the WebSocketServer objects alive (though they might be rooted via the sockets anyway?)
            Dictionary<int, WebSocketServer> simpleTcpProxies = new Dictionary<int, WebSocketServer>();

            IPAddress dnsAddress = GetDnsAddress();

            SocksListener socksServer = new SocksListener(IPAddress.Any, socksPort);
            socksServer.Start();

            Mentalis.Proxy.Http.HttpListener httpServer = new Mentalis.Proxy.Http.HttpListener(IPAddress.Any, httpPort);
            httpServer.Start();

            Mentalis.Proxy.Http.HttpListener httpsServer = new Mentalis.Proxy.Http.HttpListener(IPAddress.Any, httpsPort);
            httpsServer.Start();

            WebSocketServer webSocketDnsServer = new WebSocketServer(wsUrl + ":" + webSockDnsPort);
            webSocketDnsServer.Start(webSocket =>
            {
                bool closed = false;
                webSocket.OnOpen = () =>
                {
                    Console.WriteLine("Connected (DNS)");
                };
                webSocket.OnClose = () =>
                {
                    closed = true;
                    Console.WriteLine("Disconnected (DNS)");
                };
                webSocket.OnBinary = (byte[] data) =>
                {
                    try
                    {
                        int addrLen = BitConverter.ToInt32(data, 0) + 4;
                        byte[] addrBytes = new byte[addrLen];
                        Buffer.BlockCopy(data, 0, addrBytes, 0, addrBytes.Length);

                        byte[] dnsReq = new byte[data.Length - addrLen];
                        Buffer.BlockCopy(data, addrLen, dnsReq, 0, dnsReq.Length);

                        UdpClient client = new UdpClient();
                        client.Connect(dnsAddress, 53);
                        client.Send(dnsReq, dnsReq.Length);

                        IPEndPoint remoteEndPoint = new IPEndPoint(IPAddress.Any, 53);
                        byte[] response = client.Receive(ref remoteEndPoint);
                        
                        byte[] responseBuffer = new byte[addrBytes.Length + response.Length];
                        Buffer.BlockCopy(addrBytes, 0, responseBuffer, 0, addrBytes.Length);
                        Buffer.BlockCopy(response, 0, responseBuffer, addrLen, response.Length);
                        webSocket.Send(responseBuffer);
                    }
                    catch
                    {
                        try
                        {
                            closed = true;
                            webSocket.Close();
                        }
                        catch
                        {
                        }
                    }
                };
                ThreadPool.QueueUserWorkItem((object o) =>
                {
                    DateTime time = DateTime.Now;
                    while (!closed)
                    {
                        Thread.Sleep(1000);
                        if (DateTime.Now - TimeSpan.FromMilliseconds(dnsTimeout) > time)
                        {
                            try
                            {
                                webSocket.Close();
                            }
                            catch
                            {
                            }
                            break;
                        }
                    }
                });
            });

            foreach (KeyValuePair<int, int> proxy in simpleTcpProxyPorts)
            {
                WebSocketServer webSocketServer = new WebSocketServer(wsUrl + ":" + proxy.Key);
                simpleTcpProxies[proxy.Key] = webSocketServer;
                webSocketServer.Start(webSocket =>
                {
                    TcpClient client = new TcpClient();
                    Thread clientThread = null;
                    try
                    {
                        client.Connect(IPAddress.Loopback, proxy.Value);
                    }
                    catch
                    {
                        Close(client, webSocket, clientThread);
                    }

                    webSocket.OnOpen = () =>
                    {
                        Console.WriteLine("Connected");
                        clientThread = new Thread(delegate ()
                        {
                            try
                            {
                                byte[] buff = new byte[4096];
                                while (client.Connected)
                                {
                                    int readBytes = client.Client.Receive(buff);
                                    if (readBytes > 0)
                                    {
                                        Console.WriteLine("Send " + readBytes);
                                        byte[] temp = new byte[readBytes];
                                        Buffer.BlockCopy(buff, 0, temp, 0, temp.Length);
                                        webSocket.Send(temp);
                                    }
                                    else
                                    {
                                        Close(client, webSocket, clientThread);
                                        break;
                                    }
                                }
                            }
                            catch
                            {
                                Close(client, webSocket, clientThread);
                            }
                        });
                        try
                        {
                            clientThread.Start();
                        }
                        catch
                        {
                            Close(client, webSocket, clientThread);
                        }
                    };

                    webSocket.OnClose = () =>
                    {
                        Console.WriteLine("Disconnected");
                        Close(client, webSocket, clientThread);
                    };
                    webSocket.OnBinary = (byte[] data) =>
                    {
                        try
                        {
                            Console.WriteLine("Recv " + data.Length);
                            if (client.Client.Send(data) != data.Length)
                            {
                                Console.WriteLine("TODO: Better handling of data (send)");
                            }
                        }
                        catch
                        {
                            Close(client, webSocket, clientThread);
                        }
                    };
                });
            }

            Thread.Sleep(Timeout.Infinite);
        }

        static void Close(TcpClient client, IWebSocketConnection webSocket, Thread clientThread)
        {
            try
            {
                if (client != null)
                {
                    client.Close();
                }
            }
            catch
            {
            }
            try
            {
                if (webSocket != null)
                {
                    webSocket.Close();
                }
            }
            catch
            {
            }
            if (clientThread != null)
            {
                try
                {
                    clientThread.Abort();
                }
                catch
                {
                }
            }
        }

        static IPAddress GetDnsAddress()
        {
            NetworkInterface[] networkInterfaces = NetworkInterface.GetAllNetworkInterfaces();
            foreach (NetworkInterface networkInterface in networkInterfaces)
            {
                if (networkInterface.OperationalStatus == OperationalStatus.Up)
                {
                    IPInterfaceProperties ipProperties = networkInterface.GetIPProperties();
                    IPAddressCollection dnsAddresses = ipProperties.DnsAddresses;
                    foreach (IPAddress dnsAdress in dnsAddresses)
                    {
                        return dnsAdress;
                    }
                }
            }
            throw new InvalidOperationException("Unable to find DNS Address");
        }
    }
}
