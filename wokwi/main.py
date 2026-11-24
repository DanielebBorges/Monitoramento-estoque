
import network
import time
import urequests
import json
from machine import Pin

led_vermelho = Pin(12, Pin.OUT)
led_verde = Pin(13, Pin.OUT)
pir = Pin(21, Pin.IN)

URL = "https://dtryptqiigbkozgewcoi.supabase.co/functions/v1/registrar-movimentacao"

TOKEN = "Token_aqui"

wifi = network.WLAN(network.STA_IF)
wifi.active(True)
wifi.connect("Wokwi-GUEST", "")

while not wifi.isconnected():
    time.sleep(1)

print("Wi-Fi conectado!")
print("Sistema de monitoramento iniciado!")

contador = 0
estado_anterior = 0

led_vermelho.off()
led_verde.on()

while True:
    estado_pir = pir.value()

    if estado_pir == 1 and estado_anterior == 0:
        contador += 1

        print("MOVIMENTACAO DETECTADA!")
        print("Total:", contador)

        led_vermelho.on()
        led_verde.off()

        dados = {
            "dispositivo": "ESP32-01",
            "evento": "movimento",
            "total_movimentos": contador
        }

        headers = {
            "Content-Type": "application/json",
            "x-stock-token": TOKEN
        }

        try:
            resposta = urequests.post(
                URL,
                data=json.dumps(dados),
                headers=headers
            )

            print("Status envio:", resposta.status_code)
            print("Resposta:", resposta.text)
            resposta.close()

        except Exception as erro:
            print("Erro ao enviar:", erro)

        time.sleep(2)

        led_vermelho.off()
        led_verde.on()

    estado_anterior = estado_pir

    time.sleep(0.1)
